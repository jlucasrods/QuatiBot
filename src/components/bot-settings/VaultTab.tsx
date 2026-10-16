
import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useStore, type Bot } from "@/state/store";
import { McpServersPanel } from "../McpServersPanel";

import { SignedInSites } from "../SignedInSites";

import type { useBotSettingsDerived } from "./useBotSettingsDerived";

const headCls = "mb-1 flex min-h-7 items-center justify-between gap-3";
const headTitleCls = "text-[12px] text-ink-secondary";
const headActionCls = "rounded-md px-1.5 py-0.5 text-[12px] font-medium text-accent-text hover:bg-raised";


const noteCls = "mt-2 text-[12.5px] leading-relaxed text-ink-secondary";

export function VaultTab({
  bot,
  derived,
  onOpenBrowser,
}: {
  bot: Bot;
  derived: Pick<
    ReturnType<typeof useBotSettingsDerived>,
    "browserEnabled"
  >;
  onOpenBrowser: () => void;
}) {
  const { state } = useStore();
  const ownerOrAdmin = useOwnerOrAdmin();
  const { browserEnabled } = derived;

  const profileId = bot.browserProfile ?? "";
  const profile = (state.config?.browserProfiles ?? []).find((candidate) => candidate.id === profileId);
  const temporary = profileId === "guest";
  const ownChrome = profile?.browser === "chrome" && state.config?.browserEngine?.myChrome === true;
  const sharedBy = profileId && !temporary
    ? state.bots.filter((candidate) => candidate.browserProfile === profileId).map((candidate) => candidate.name)
    : [bot.name];

  return (
    <div role="tabpanel" data-simple-vault className="mt-5 flex flex-col gap-6">
      <p className="text-[13px] leading-relaxed text-ink-secondary">{t("botSettings.simple.vaultIntro", { name: bot.name })}</p>

      <McpServersPanel />

      <section>
        <div className={headCls}>
          <h3 className={headTitleCls}>{t("botSettings.simple.logins")}</h3>
          <button type="button" data-simple-add-login onClick={onOpenBrowser} className={headActionCls}>
            {t("botSettings.simple.addLogin")}
          </button>
        </div>
        {!browserEnabled ? (
          <p className={noteCls}>{t("botSettings.simple.loginsOff", { name: bot.name })}</p>
        ) : temporary ? (
          <p className={noteCls}>{t("settings.profiles.temporaryHint")}</p>
        ) : ownChrome ? (
          <p className={noteCls}>{t("settings.profiles.myChromeHint")}</p>
        ) : (
          <>
            {/* Security: reading and clearing a browser's sign-ins is the owner's or an admin's; the server refuses anyone else. */}
            {ownerOrAdmin !== false && (profileId === "" || profile) && (
              <SignedInSites bare key={`${bot.id}:${profileId}`} target={{ bot: bot.id }} sharedBy={sharedBy} disabled={Boolean(bot.busy)} />
            )}
            <p className={noteCls}>{t("botSettings.simple.loginsHint", { name: bot.name })}</p>
          </>
        )}
      </section>
    </div>
  );
}
