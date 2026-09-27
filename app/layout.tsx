import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SiteChrome } from "@/components/site-chrome";
import type { Doctor } from "@/lib/contract";
import { doctorById } from "@/lib/queries";
import { DEMO_DOCTOR_ID } from "@/lib/scenario";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "MediShift",
  description: "Formulary change console for reviewing affected patients and covered alternatives.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: LayoutProps<"/">) {
  let doctor: Doctor | null = null;
  try {
    doctor = await doctorById(DEMO_DOCTOR_ID);
  } catch {
    doctor = null;
  }

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      style={{ colorScheme: "light" }}
    >
      <body className="flex min-h-full flex-col bg-[#f3f1fb] text-[#1b1733]">
        <SiteChrome doctor={doctor}>{children}</SiteChrome>
      </body>
    </html>
  );
}
