import type { TagMutation, TagSnapshot } from "@heed/shared";
import { ApiError, apiClient } from "./client";

export type TagCommand = TagMutation extends infer T ? T extends TagMutation ? Omit<T, "expectedRevision"> : never : never;
export const tagsApi = {
  list: () => apiClient.get<TagSnapshot>("/api/tags"),
  mutate: async (mutation: TagMutation) => {
    try { return await apiClient.post<TagSnapshot>("/api/tags", mutation); }
    catch (error) {
      if (error instanceof ApiError) throw error;
      throw new Error("Failed to save tags");
    }
  },
};
