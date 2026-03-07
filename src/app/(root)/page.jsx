import Link from "next/link";

const Page = () => {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-4xl flex-col items-center justify-center px-6 py-16 text-center">
      <h1 className="text-4xl font-bold tracking-tight md:text-5xl">
        Build Faster With LogicK
      </h1>
      <p className="mt-4 max-w-2xl text-base text-muted-foreground md:text-lg">
        Turn your idea into a working Next.js app by describing what you want to
        build.
      </p>
      <Link
        href="/pricing"
        className="mt-8 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
      >
        Get Started
      </Link>
    </main>
  );
};

export default Page;
