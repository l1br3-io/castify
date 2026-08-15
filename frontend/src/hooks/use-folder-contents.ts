// `useFolderContents` — mixed direct-children listing for one folder
// (M9 FR-5).
//
// The query key spreads the full params object (path + filters + page) so
// each folder view caches separately; `keepPreviousData` avoids a loading
// flash on pagination/filter changes — same posture as `useVideos`.

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { fetchFolderContents } from "../api/folders";

export const FOLDER_CONTENTS_QUERY_KEY = ["folder-contents"] as const;

export interface UseFolderContentsParams {
  path: string;
  page?: number;
  provider?: string;
  kind?: string;
  q?: string;
}

export function useFolderContents(params: UseFolderContentsParams) {
  return useQuery({
    queryKey: [...FOLDER_CONTENTS_QUERY_KEY, params] as const,
    queryFn: () => fetchFolderContents(params),
    placeholderData: keepPreviousData,
  });
}
