import type { TagMutation, TagSnapshot } from "@heed/shared";
import { apiClient } from "./client";

export type TagCommand = TagMutation extends infer T ? T extends TagMutation ? Omit<T, "expectedRevision"> : never : never;
export const tagsApi = {
  list: () => apiClient.get<TagSnapshot>("/api/tags"),
  mutate: (mutation: TagMutation) => apiClient.post<TagSnapshot>("/api/tags", mutation),
};
