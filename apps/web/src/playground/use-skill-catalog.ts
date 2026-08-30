import { useCallback, useState } from "react";
import { api } from "../api";
import type { SkillMetadata } from "../types";

export interface SkillCatalogController {
  catalog: SkillMetadata[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Loads platform skills and keeps catalog failures local to the catalog. */
export function useSkillCatalog(): SkillCatalogController {
  const [catalog, setCatalog] = useState<SkillMetadata[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.listSkills();
      setCatalog(response.skills);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  return { catalog, loading, error, refresh };
}
