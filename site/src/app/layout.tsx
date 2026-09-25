import React from "react";
import type { LayoutProps, Metadata } from "@farm.js/core";
import "./globals.css";

export const metadata: Metadata = {
  title: "tress — a tiny coding agent",
  description:
    "A coding agent that works in your project directory. One native binary, or the same engine in a browser tab.",
};

export default function RootLayout({ children }: LayoutProps) {
  return <>{children}</>;
}
