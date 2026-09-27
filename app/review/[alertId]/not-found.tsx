import Link from "next/link";

export default function AlertNotFound() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight text-[#1b1733]">Patient alert not found</h1>
      <p className="text-base text-[#3c3658]">This coverage alert is not in the current database.</p>
      <Link href="/" className="text-sm font-semibold text-[#5c4dff]">
        Back to dashboard
      </Link>
    </main>
  );
}
