import { create } from "zustand";
import { PromptVersion } from "@/lib/types";
import { toast } from "sonner";

interface PromptsState {
    prompts: PromptVersion[];
    loading: boolean;
    loaded: boolean;
    fetchPrompts: () => Promise<void>;
    activatePrompt: (id: string) => Promise<void>;
    deactivateAll: () => Promise<void>;
    deleteApoVersionsAndReset: () => Promise<void>;
    evaluatePrompt: (id: string) => Promise<void>;
}

interface ApoState {
    logs: string[];
    loading: boolean;
    loaded: boolean;
    progress: number;
    progressLabel: string;
    compareData: {
        original: string;
        optimized: string | null;
        latestApoRun?: {
            baseline: { mae: number; testFp: number; testInv: number; dqAccuracy: number | null; prompt_text: string };
            optimized: { mae: number; testFp: number; testInv: number; dqAccuracy: number | null; prompt_text: string };
            versionBase: string;
        };
    } | null;
    fetchCompare: () => Promise<void>;
    runApo: () => Promise<void>;
}

export const usePromptsStore = create<PromptsState>((set, get) => ({
    prompts: [],
    loading: false,
    loaded: false,
    fetchPrompts: async () => {
        set({ loading: true });
        try {
            const res = await fetch("/api/prompts");
            const data = await res.json();
            set({ prompts: data.prompts ?? [], loaded: true });
        } 
        catch {
            toast.error("Failed to load admin data");
        }
        finally {
            set({loading: false });
        }
    },
    activatePrompt: async (id: string) => {
        const res = await fetch("/api/prompts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "activate", id }),
        });
        if (res.ok) {
            toast.success("Prompt activated — next ranking run will use this prompt");
            set((state) => ({
                prompts: state.prompts.map((p) => ({ ...p, is_active: p.id === id }))
            }));
        } else {
            toast.error("Failed to activate prompt");
        }
    },
    deactivateAll: async () => {
        const res = await fetch("/api/prompts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "deactivate_all" }),
        });
        if (res.ok) {
            toast.success("All prompts deactivated — using default hardcoded prompt");
            set((state) => ({
                prompts: state.prompts.map((p) => ({ ...p, is_active: false }))
            }));
        } else {
            toast.error("Failed to deactivate all");
        }
    },
    deleteApoVersionsAndReset: async () => {
        const res = await fetch("/api/prompts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "delete_apo_versions" }),
        });
        if (res.ok) {
            toast.success("All APO versions deleted — using default prompt");
            get().fetchPrompts();
            useApoStore.getState().fetchCompare();
        } else {
            const data = await res.json().catch(() => ({}));
            toast.error(data?.error ?? "Failed to delete APO versions");
        }
    },
    evaluatePrompt: async (id: string) => {
        const res = await fetch("/api/prompts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "evaluate", id }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            toast.info("Evaluación iniciada. Espera 2–5 min y recarga la página para ver las métricas.");
        } else {
            toast.error(data?.error ?? "Failed to start evaluation");
        }
    }
}));

export const useApoStore = create<ApoState>((set, get) => ({
    logs: [],
    loading: false,
    loaded: false,
    progress: 0,
    progressLabel: "",
    compareData: null,
    fetchCompare: async () => {
        try {
            const res = await fetch(`/api/apo/compare?t=${Date.now()}`, { cache: "no-store" });
            const data = await res.json();
            toast.success("Comparison data loaded");
            set({ compareData: { original: data.original, optimized: data.optimized, latestApoRun: data.latestApoRun ?? undefined }, loaded: true });
        } catch {
            toast.error("Failed to fetch comparison data");
            set({ compareData: null });
        }
    },
    runApo: async () => {
        set({ loading: true, logs: [], progress: 0, progressLabel: "" });
        try {
            const res = await fetch("/api/apo/run", { method: "POST" });
            if (!res.ok || !res.body) {
                toast.error("Failed to start APO");
                return;
            }
            toast.info("APO started — this may take several minutes");
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split("\n").filter((l) => l.startsWith("data: "));
                for (const line of lines) {
                    try {
                        const parsed = JSON.parse(line.slice(6));
                        if (parsed.type === "log" && parsed.text) {
                            set((state) => ({
                                logs: [...state.logs, parsed.text]
                            }));
                        } else if (parsed.type === "progress") {
                            set({
                                progress: parsed.percent ?? 0,
                                progressLabel: parsed.label ?? "",
                            });
                        } else if (parsed.type === "done") {
                            set({ progress: 100, progressLabel: "APO complete" });
                            toast.success("APO completed");
                            usePromptsStore.getState().fetchPrompts();
                            get().fetchCompare();
                        } else if (parsed.type === "error") {
                            toast.error(parsed.message ?? "APO failed");
                        }
                    } catch {
                        // ignore parse errors from partial chunks
                    }
                }
            }
        } catch {
            toast.error("APO request failed");
        } finally {
            set({ loading: false });
        }
    }
}));
