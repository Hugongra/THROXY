import { redirect } from "next/navigation";

export default function PromptsIndex() {
  redirect("/prompts/versions");
}