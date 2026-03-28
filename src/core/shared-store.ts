import type {
  SharedKnowledgeEntry,
  SharedKnowledgeFilter,
  StoreResult,
} from "../shared/types";

export interface SharedKnowledgeStore {
  list(filter?: SharedKnowledgeFilter): Promise<SharedKnowledgeEntry[]>;
  getById(id: string): Promise<SharedKnowledgeEntry | null>;
  save(entry: SharedKnowledgeEntry): Promise<StoreResult>;
  update(
    id: string,
    patch: Partial<SharedKnowledgeEntry>,
  ): Promise<StoreResult>;
  remove(id: string): Promise<StoreResult>;
  deletePending(id: string): Promise<StoreResult>;
}
