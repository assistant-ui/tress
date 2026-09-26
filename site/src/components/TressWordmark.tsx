export function TressMark() {
  return (
    <svg
      className="tress-mark"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M7 3H3v18h4m10-18h4v18h-4" strokeWidth="1.5" opacity=".6" />
      <path d="M7.5 5.5h9M12 5.5v13" strokeWidth="2" />
    </svg>
  );
}

export function TressWordmark() {
  return (
    <span className="tress-wordmark">
      <span className="visually-hidden">tress</span>
      <TressMark />
      <span aria-hidden="true">ress</span>
    </span>
  );
}
