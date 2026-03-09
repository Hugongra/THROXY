
"use client";

import Link from "next/link";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePathname } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { usePromptsStore } from "./prompts-service";

export default function PromptsLayout({children,}: {
  children: React.ReactNode;
}) {
    const pathname = usePathname();
    const prompts = usePromptsStore((s) => s.prompts);
    
    const activePrompt = prompts.find((p) => p.is_active);
    const bestApo = prompts
    .filter((p) => p.source === "apo" && p.mae !== null)
    .sort((a, b) => (a.mae ?? 99) - (b.mae ?? 99))[0];
    
    let active: string | undefined = "versions";
    if (pathname.includes("/versions")) active = "versions";
    if (pathname.includes("/optimization")) active = "optimization";

    return (
        <div className="space-y-6 sm:space-y-8 w-full max-w-full min-w-0">
            <section className="space-y-4">
                <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-throxy-black">
                Prompts Panel
                </h1>
                <p className="text-muted-foreground">
                Manage prompt versions and APO optimization.
                </p>
            </section>
            <section className="space-y-6 sm:space-y-8">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
                <Card>
                    <CardContent className="pt-6">
                    <p className="text-sm text-muted-foreground">Prompt Versions</p>
                    <p className="text-2xl font-bold">{prompts.length}</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="pt-6">
                    <p className="text-sm text-muted-foreground">Active Prompt</p>
                    <p className="text-2xl font-bold">
                        {activePrompt ? activePrompt.version : "Default (v1)"}
                    </p>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="pt-6">
                    <p className="text-sm text-muted-foreground">Best APO MAE</p>
                    <p className="text-2xl font-bold">
                        {bestApo ? bestApo.mae?.toFixed(3) : "—"}
                    </p>
                    </CardContent>
                </Card>
                </div>
            </section>
            <Tabs value={active}>
                <TabsList className="mb-6">
                <TabsTrigger value="versions" asChild>
                    <Link href="/prompts/versions">Prompt Versions</Link>
                </TabsTrigger>
                <TabsTrigger value="optimization" asChild>
                    <Link href="/prompts/optimization">Prompt Optimization</Link>
                </TabsTrigger>
                </TabsList>
            </Tabs>
            {children}
        </div>
    );
}