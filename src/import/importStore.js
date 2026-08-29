import { cloneValue } from "../kernel/canonicalize.js";
import { MemoryRepository } from "../persistence/memoryRepository.js";

export class ImportStore {
  constructor(repository) {
    this.repository = repository;
  }

  async initialize() {
    await this.repository.initialize();
    return this;
  }

  async saveJob(job) {
    return this.repository.putImport(cloneValue(job));
  }

  async createJob(job) {
    return this.repository.createImport(cloneValue(job));
  }

  async commitJobMutation(mutation) {
    return this.repository.commitImportMutation({
      ...cloneValue(mutation),
      nextJob: cloneValue(mutation.nextJob),
      documents: cloneValue(mutation.documents ?? []),
      blobs: cloneValue(mutation.blobs ?? []),
    });
  }

  async getJob(jobId) {
    return this.repository.getImport(jobId);
  }

  async listJobs(caseId = undefined) {
    return this.repository.listImports(caseId);
  }

  async saveDocument(document) {
    return this.repository.putDocument(cloneValue(document));
  }

  async getDocument(documentId) {
    return this.repository.getDocument(documentId);
  }

  async listDocuments(caseId = undefined) {
    return this.repository.listDocuments(caseId);
  }

  async deleteDocument(documentId) {
    return this.repository.deleteDocument(documentId);
  }

  supportsRawInputPersistence() {
    return typeof this.repository.putBlob === "function" && typeof this.repository.getBlob === "function";
  }

  async saveRawInput(blobId, input) {
    if (!this.supportsRawInputPersistence()) return false;
    await this.repository.putBlob(blobId, cloneValue(input));
    return true;
  }

  async getRawInput(blobId) {
    if (!this.supportsRawInputPersistence()) return null;
    return this.repository.getBlob(blobId);
  }

  async deleteRawInput(blobId) {
    if (typeof this.repository.deleteBlob !== "function") return false;
    return this.repository.deleteBlob(blobId);
  }
}

export class InMemoryImportStore extends ImportStore {
  constructor() {
    super(new MemoryRepository());
  }
}
