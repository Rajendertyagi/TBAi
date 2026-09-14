import { appConfig } from "@/config/navigation";
import { welcomeConfig } from "@/config/welcome";
import { cn } from "@/lib/utils";

export function WelcomeHero() {
  const copy = welcomeConfig.copy;
  const layout = welcomeConfig.layout;
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <h1 className={cn(layout.heroTitleClass)}>
        {copy.greetingTitle(appConfig.branding.appName)}
      </h1>
      <p className={cn(layout.heroSubtitleClass)}>{copy.greetingSubtitle}</p>
      <p className={cn(layout.tipClass)} aria-hidden="true">
        {copy.shortcutHint}
      </p>
    </div>
  );
}
