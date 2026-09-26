import type { ComponentProps } from "react";

const paths = {
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  files: <><path d="M5 3h9l5 5v13H5z" /><path d="M14 3v6h5M8 13h8M8 17h5" /></>,
  threads: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M13 9h4M13 13h4" /></>,
  terminal: <><path d="m4 6 5 5-5 5M12 17h8" /></>,
  chevron: <path d="m9 5 7 7-7 7" />,
  enter: <path d="M19 5v9H5m5-5-5 5 5 5" />,
} as const;

export function TerminalIcon({
  name,
  className = "",
  ...props
}: ComponentProps<"svg"> & { name: keyof typeof paths }) {
  return (
    <svg
      {...props}
      className={`terminal-icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
