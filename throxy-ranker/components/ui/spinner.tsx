export function Spinner({ size = "md", variant = "primary" }: { size?: "sm" | "md"; variant?: "primary" | "current" }) {
  const sizeClass = size === "sm" ? "h-4 w-4 border-2" : "h-8 w-8 border-4";
  const colorClass = variant === "current" ? "border-current" : "border-primary";
  return (
    <span
      className={`inline-block animate-spin rounded-full border-t-transparent ${sizeClass} ${colorClass}`}
      aria-hidden
    />
  );
}
