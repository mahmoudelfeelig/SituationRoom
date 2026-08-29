import { ERROR_CODES, SituationRoomError } from "../kernel/errors.js";

function assertPack(pack) {
  const required = ["id", "version", "label", "createFixture", "validateCase", "mapImportedDocuments"];
  const missing = required.filter((field) =>
    ["createFixture", "validateCase", "mapImportedDocuments"].includes(field)
      ? typeof pack?.[field] !== "function"
      : typeof pack?.[field] !== "string" || !pack[field],
  );
  if (missing.length) {
    throw new TypeError(`Invalid domain pack; missing ${missing.join(", ")}.`);
  }
  return pack;
}

export class DomainPackRegistry {
  #packs = new Map();

  constructor(packs = []) {
    packs.forEach((pack) => this.register(pack));
  }

  register(pack) {
    assertPack(pack);
    if (this.#packs.has(pack.id)) throw new TypeError(`Domain pack '${pack.id}' is already registered.`);
    this.#packs.set(pack.id, pack);
    return this;
  }

  get(packId) {
    const pack = this.#packs.get(packId);
    if (!pack) {
      throw new SituationRoomError(ERROR_CODES.NOT_FOUND, `Unknown domain pack '${packId}'.`, {
        packId,
      });
    }
    return pack;
  }

  has(packId) {
    return this.#packs.has(packId);
  }

  list() {
    return [...this.#packs.values()].map((pack) => ({
      id: pack.id,
      version: pack.version,
      label: pack.label,
      description: pack.description,
      riskClass: pack.riskClass,
      instrumentHints: [...(pack.instrumentHints ?? [])],
    }));
  }
}
