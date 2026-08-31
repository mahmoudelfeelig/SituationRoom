import { createWebMcpGateway, WebMcpGateway } from "./webmcp/gateway.js";

let activeGateway = null;

export async function registerSituationRoomTools({
  ports,
  modelContext = globalThis.document?.modelContext,
  actor,
  onStatus,
  onReceipt,
  onActivity,
  outputLimit,
  receiptLedger,
  invocationStore,
} = {}) {
  if (!ports) {
    const result = {
      available: false,
      toolCount: 0,
      activeTools: [],
      reason: "ports-required",
      gateway: null,
    };
    if (typeof onStatus === "function") await onStatus(result);
    return result;
  }

  if (
    activeGateway &&
    activeGateway.ports === ports &&
    activeGateway.modelContext === modelContext &&
    activeGateway.snapshot().available
  ) {
    await activeGateway.flush();
    return activeGateway.snapshot();
  }
  if (activeGateway) {
    const stopped = await activeGateway.stop();
    if (stopped.pendingExecutions > 0) {
      return {
        available: false,
        toolCount: 0,
        activeTools: [],
        reason: "prior-executions-pending",
        gateway: activeGateway,
      };
    }
    activeGateway = null;
  }
  const gateway = createWebMcpGateway({
    ports,
    modelContext,
    actor,
    onStatus,
    onReceipt,
    onActivity,
    outputLimit,
    receiptLedger,
    invocationStore,
  });
  const result = await gateway.start();
  if (result.available) activeGateway = gateway;
  return { ...result, gateway };
}

export async function unregisterSituationRoomTools() {
  if (!activeGateway) return { stopped: true, pendingExecutions: 0 };
  const gateway = activeGateway;
  activeGateway = null;
  return gateway.stop();
}

export function getSituationRoomGateway() {
  return activeGateway;
}

export { createWebMcpGateway, WebMcpGateway };
export {
  IndexedDbReceiptLedger,
  LocalStorageReceiptLedger,
  ReceiptLedger,
  WEBMCP_RECEIPT_STORAGE_KEY,
} from "./webmcp/receiptLedger.js";
export {
  clearWebMcpJournalDatabase,
  IndexedDbInvocationStore,
  LocalStorageInvocationStore,
  MemoryInvocationStore,
  WEBMCP_JOURNAL_DATABASE_NAME,
  WEBMCP_INVOCATION_STORAGE_KEY,
} from "./webmcp/invocationStore.js";
