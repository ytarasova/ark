import { cn } from "../../lib/utils.js";

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  priority?: "high" | "medium" | "low";
}

export interface TodoListProps extends React.ComponentProps<"div"> {
  items: TodoItem[];
  onToggle?: (id: string) => void;
}

const PRIORITY_CLASSES: Record<string, string> = {
  high: "bg-[rgba(248,113,113,0.12)] text-[var(--failed)]",
  medium: "bg-[rgba(251,191,36,0.12)] text-[var(--waiting)]",
  low: "bg-[rgba(96,165,250,0.12)] text-[var(--completed)]",
};

/**
 * Checkbox items with priority labels.
 */
export function TodoList({ items, onToggle, className, ...props }: TodoListProps) {
  return (
    <div className={cn("flex flex-col gap-0", className)} {...props}>
      {items.map((item) => (
        <label
          key={item.id}
          className={cn(
            "flex items-center gap-3 px-3 py-2 cursor-pointer",
            "hover:bg-[var(--bg-hover)] transition-colors duration-150 rounded-[var(--radius-sm)]",
          )}
        >
          <input
            type="checkbox"
            checked={item.done}
            onChange={() => onToggle?.(item.id)}
            className="accent-[var(--primary)] w-3.5 h-3.5 shrink-0"
          />
          <span className={cn("text-[13px] flex-1", item.done && "line-through text-[var(--fg-muted)]")}>
            {item.text}
          </span>
          {item.priority && (
            <span
              className={cn(
                "text-[9px] font-medium uppercase tracking-[0.04em] px-1.5 py-[1px] rounded",
                PRIORITY_CLASSES[item.priority] ?? "",
              )}
            >
              {item.priority}
            </span>
          )}
        </label>
      ))}
    </div>
  );
}
