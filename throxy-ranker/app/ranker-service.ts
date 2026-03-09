import { IngestResponse, RankedLead } from "@/lib/types";
import { create } from "zustand";

interface LeadsState {
  leads: RankedLead[];
  setLeads: (leads: RankedLead[]) => void;
  addLeads: (batch: RankedLead[]) => void;
}

interface LiveStats {
  companiesDone: number;
  companiesTotal: number;
  totalCost: number;
}

interface IngestState {
  summary: IngestResponse | null;
  liveStats: LiveStats;

  setSummary: (summary: IngestResponse | null) => void;
  setLiveStats: (stats: LiveStats) => void;
  updateLiveStats: (partial: Partial<LiveStats>) => void;
}

export const useLeadsStore = create<LeadsState>((set) => ({
  leads: [],
  
  setLeads: (leads) => set({ leads }),
  addLeads: (batch) =>
    set((state) => ({
      leads: [...state.leads, ...batch],
  })),
}));

export const useIngestStore = create<IngestState>((set) => ({
  summary: null,

  liveStats: {
    companiesDone: 0,
    companiesTotal: 0,
    totalCost: 0,
  },

  setSummary: (summary) => set({ summary }),

  setLiveStats: (stats) => set({ liveStats: stats }),

  updateLiveStats: (partial) =>
    set((state) => ({
      liveStats: { ...state.liveStats, ...partial },
    })),
}));