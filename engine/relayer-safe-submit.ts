import { createAbstractSigner } from "@polymarket/builder-abstract-signer";
import type { WalletClient } from "viem";
import { getContractConfig, isSafeContractConfigValid } from "@polymarket/builder-relayer-client/dist/config/index.js";
import { deriveSafe } from "@polymarket/builder-relayer-client/dist/builder/derive.js";
import { buildSafeTransactionRequest } from "@polymarket/builder-relayer-client/dist/builder/safe.js";
import {
  OperationType,
  RelayerTransactionState,
  TransactionType,
} from "@polymarket/builder-relayer-client";
import { SAFE_NOT_DEPLOYED } from "@polymarket/builder-relayer-client/dist/errors.js";

const GET_DEPLOYED = "/deployed";
const GET_NONCE = "/nonce";
const GET_TRANSACTION = "/transaction";
const SUBMIT_TRANSACTION = "/submit";

function normalizeRelayerBase(url: string): string {
  const t = url.trim();
  return t.endsWith("/") ? t.slice(0, -1) : t;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type RelayerAuthHeaders = {
  RELAYER_API_KEY: string;
  RELAYER_API_KEY_ADDRESS: string;
};

async function relayerGetJson<T>(
  baseUrl: string,
  path: string,
  params: Record<string, string>,
  headers?: RelayerAuthHeaders,
): Promise<T> {
  const u = new URL(path, `${baseUrl}/`);
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, v);
  }
  const h: Record<string, string> = { Accept: "application/json" };
  if (headers) {
    h.RELAYER_API_KEY = headers.RELAYER_API_KEY;
    h.RELAYER_API_KEY_ADDRESS = headers.RELAYER_API_KEY_ADDRESS;
  }
  const res = await fetch(u.toString(), { method: "GET", headers: h });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`relayer GET ${path} ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

async function relayerPostJson<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: RelayerAuthHeaders,
): Promise<T> {
  const u = new URL(path, `${baseUrl}/`);
  const res = await fetch(u.toString(), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      RELAYER_API_KEY: headers.RELAYER_API_KEY,
      RELAYER_API_KEY_ADDRESS: headers.RELAYER_API_KEY_ADDRESS,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`relayer POST ${path} ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

type SubmitResponse = {
  transactionID: string;
  transactionHash?: string;
  state?: string;
};

type TxRow = {
  transactionID: string;
  transactionHash?: string;
  state: string;
};

/**
 * Submits a single Safe-wrapped transaction via Polymarket Relayer HTTP `POST /submit`
 * using `RELAYER_API_KEY` + `RELAYER_API_KEY_ADDRESS` (no Builder signing).
 * Mirrors `RelayClient.executeSafeTransactions` for one inner call.
 */
export async function submitSafeTransactionViaRelayerApi(opts: {
  wallet: WalletClient;
  chainId: number;
  relayerBaseUrl: string;
  relayerApiKey: string;
  relayerApiKeyAddress: string;
  transaction: { to: string; data: string; value: string };
  metadata?: string;
}): Promise<{ transactionHash: string; transactionID: string }> {
  const baseUrl = normalizeRelayerBase(opts.relayerBaseUrl);
  const auth: RelayerAuthHeaders = {
    RELAYER_API_KEY: opts.relayerApiKey,
    RELAYER_API_KEY_ADDRESS: opts.relayerApiKeyAddress,
  };

  const signer = createAbstractSigner(opts.chainId, opts.wallet);
  const contractConfig = getContractConfig(opts.chainId);
  if (!isSafeContractConfigValid(contractConfig.SafeContracts)) {
    throw new Error("Safe contracts not configured for this chain");
  }

  const from = await signer.getAddress();
  const safe = deriveSafe(from, contractConfig.SafeContracts.SafeFactory);

  const deployedResp = await relayerGetJson<{ deployed: boolean }>(
    baseUrl,
    GET_DEPLOYED,
    { address: safe },
    auth,
  );
  if (!deployedResp.deployed) {
    throw SAFE_NOT_DEPLOYED;
  }

  const noncePayload = await relayerGetJson<{ nonce: string }>(
    baseUrl,
    GET_NONCE,
    { address: from, type: TransactionType.SAFE },
    auth,
  );

  const safeTx = {
    to: opts.transaction.to,
    operation: OperationType.Call,
    data: opts.transaction.data,
    value: opts.transaction.value,
  };

  const args = {
    transactions: [safeTx],
    from,
    nonce: noncePayload.nonce,
    chainId: opts.chainId,
  };

  const request = await buildSafeTransactionRequest(
    signer,
    args,
    contractConfig.SafeContracts,
    opts.metadata ?? "",
  );

  const submitResp = await relayerPostJson<SubmitResponse>(
    baseUrl,
    SUBMIT_TRANSACTION,
    request,
    auth,
  );

  const txId = submitResp.transactionID;
  if (!txId) {
    throw new Error("relayer submit: missing transactionID");
  }

  const finalRow = await pollUntilRelayerTerminal(baseUrl, txId, auth);
  const hash = finalRow.transactionHash ?? "";
  return { transactionHash: hash, transactionID: txId };
}

async function pollUntilRelayerTerminal(
  baseUrl: string,
  transactionId: string,
  auth: RelayerAuthHeaders,
): Promise<TxRow> {
  const maxPolls = 100;
  const pollFreq = 2000;
  const okStates = [
    RelayerTransactionState.STATE_MINED,
    RelayerTransactionState.STATE_CONFIRMED,
  ];

  for (let i = 0; i < maxPolls; i++) {
    const rows = await relayerGetJson<TxRow[]>(
      baseUrl,
      GET_TRANSACTION,
      { id: transactionId },
      auth,
    );
    if (rows.length > 0) {
      const txn = rows[0]!;
      if (okStates.some((s) => s === txn.state)) {
        return txn;
      }
      if (txn.state === RelayerTransactionState.STATE_FAILED) {
        throw new Error(
          `relayer tx failed onchain id=${transactionId} hash=${txn.transactionHash ?? ""}`,
        );
      }
      if (txn.state === RelayerTransactionState.STATE_INVALID) {
        throw new Error(`relayer tx invalid id=${transactionId}`);
      }
    }
    await sleep(pollFreq);
  }

  throw new Error(`relayer poll timeout id=${transactionId}`);
}
