import { LandingNav } from "./LandingNav";
import { Hero } from "./Hero";
import { Features } from "./Features";
import { HowItWorks } from "./HowItWorks";
import { Confidential } from "./Confidential";
import { ClosingCTA } from "./ClosingCTA";
import { Footer } from "./Footer";

export function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <LandingNav />
      <main>
        <Hero />
        <Features />
        <HowItWorks />
        <Confidential />
        <ClosingCTA />
      </main>
      <Footer />
    </div>
  );
}
