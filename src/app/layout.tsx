import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Haven Operations",
  description: "Private short-term rental operations calendar",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-IN">
      <body>{children}</body>
    </html>
  );
}
