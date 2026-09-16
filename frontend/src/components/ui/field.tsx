// Field + Input — labeled form controls with automatic wiring (see
// ui/README.md § Field for the contract): Field generates the input id and
// renders label/hint/error; Input consumes both through context, so the
// input always ends up labelled, described (hint first, error last), and
// flagged aria-invalid when an error is present. Consumers never wire
// htmlFor/describedby by hand again.
//
// Gotcha: an <Input> outside a <Field> renders bare (no aria wiring) —
// pass aria-label yourself if you skip the Field. Inside a Field, don't
// pass an explicit id: Field owns the id and wires the label to it.

import {
  createContext,
  useContext,
  useId,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";

import { cn } from "./cn";

type FieldContextValue = {
  id: string;
  describedBy?: string;
  invalid: boolean;
};

const FieldContext = createContext<FieldContextValue | null>(null);

type FieldProps = {
  label: string;
  /** Persistent helper text (id-wired, announced before errors). */
  hint?: string;
  /** Validation message; sets aria-invalid on the input. */
  error?: string;
  children: ReactNode;
};

export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy =
    [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <FieldContext.Provider value={{ id, describedBy, invalid: Boolean(error) }}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {children}
        {hint && (
          <p id={hintId} className="text-xs text-[var(--color-castify-muted)]">
            {hint}
          </p>
        )}
        {error && (
          <p
            id={errorId}
            className="text-xs text-[var(--color-danger)]"
            aria-live="polite"
          >
            {error}
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
}

type InputProps = ComponentPropsWithoutRef<"input">;

export function Input({ className, id, ...rest }: InputProps) {
  const field = useContext(FieldContext) as FieldContextValue | null;
  return (
    <input
      id={id ?? field?.id}
      aria-describedby={field?.describedBy}
      aria-invalid={field?.invalid || undefined}
      className={cn(
        "w-full min-w-0 rounded-[var(--radius-button)] border bg-[var(--color-castify-canvas)] px-3 py-2 text-sm text-[var(--color-castify-text)] transition placeholder:text-[var(--color-castify-muted)] focus:outline-none focus:ring-1",
        field?.invalid
          ? "border-[var(--color-danger)] focus:border-[var(--color-danger)] focus:ring-[var(--color-danger)]"
          : "border-[var(--color-castify-rule)] focus:border-[var(--color-castify-accent)] focus:ring-[var(--color-castify-accent)]",
        className,
      )}
      {...rest}
    />
  );
}
