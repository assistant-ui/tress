// Browser adaptation of termcn's Ink Badge. See README.md and LICENSE.
import type { ComponentProps } from "react";

export function Badge({
  children,
  variant = "default",
  bordered = true,
  className = "",
  ...props
}: ComponentProps<"span"> & {
  variant?: "default" | "success" | "warning" | "error";
  bordered?: boolean;
}) {
  return (
    <span
      {...props}
      className={`terminal-badge ${className}`}
      data-variant={variant}
      data-bordered={bordered}
    >
      {children}
    </span>
  );
}
