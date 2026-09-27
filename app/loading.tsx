export default function Loading() {
  return (
    <div className="min-h-full bg-white">
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
        <div className="h-4 w-32 animate-pulse rounded bg-neutral-200" />
        <div className="h-24 w-full max-w-md animate-pulse rounded bg-neutral-200" />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="h-40 animate-pulse rounded-xl bg-neutral-100" />
          <div className="h-40 animate-pulse rounded-xl bg-neutral-100" />
        </div>
        <p className="text-base text-neutral-600">Loading affected patients…</p>
      </main>
    </div>
  );
}
