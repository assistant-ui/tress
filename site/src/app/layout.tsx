import React from "react";
import type { LayoutProps, Metadata } from "@farm.js/core";
import "./globals.css";

export const metadata: Metadata = {
  title: "tress — keep the thread",
  description:
    "A tiny, durable coding agent. One shared thread across your terminal and browser, powered by Rust and statewire.",
};

export default function RootLayout({ children }: LayoutProps) {
  return <>{children}</>;
}
