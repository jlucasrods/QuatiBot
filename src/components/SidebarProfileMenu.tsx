import { useRef, useState } from "react";
import { Gauge, Info, Keyboard, Puzzle, Settings as SettingsIcon } from "lucide-react";
import { InitialsAvatar } from "./Avatar";
import { AboutDialog } from "./AboutDialog";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";
import { ShortcutHint } from "./ShortcutHint";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
export function profileInitials(profile?: {
    name?: string;
    email?: string;
}): string {
    const name = profile?.name?.trim();
    if (name) {
        return name.split(/\s+/).slice(0, 2).map(word => word[0]!.toUpperCase()).join("");
    }
    const email = profile?.email?.trim();
    return email ? email[0]!.toUpperCase() : "?";
}
export function profileLabel(profile?: {
    name?: string;
    email?: string;
}): string {
    return profile?.name?.trim() || profile?.email?.trim() || t("sidebar.profile.you");
}
export function profileMenuItems({ usage, onUsage, onApps, onSettings, onShortcuts, onAbout }: {
    usage: boolean;
    onUsage: () => void;
    onApps: () => void;
    onSettings: () => void;
    onShortcuts: () => void;
    onAbout: () => void;
}): SidebarMenuItem[] {
    return [
        ...(usage ? [{ key: "usage", label: t("settings.section.usage"), icon: <Gauge size={18}/>, onSelect: onUsage }] : []),
        { key: "apps", label: "Extensões", icon: <Puzzle size={18}/>, onSelect: onApps },
        { key: "shortcuts", label: t("sidebar.menu.shortcuts"), icon: <Keyboard size={18}/>, trailing: <ShortcutHint id="shortcuts-cheat-sheet"/>, onSelect: onShortcuts },
        { key: "about", label: t("sidebar.menu.about"), icon: <Info size={18}/>, onSelect: onAbout },
        { key: "settings", label: t("sidebar.menu.settings"), icon: <SettingsIcon size={18}/>, onSelect: onSettings },
    ];
}
export function SidebarProfileMenu({ iconOnly = false }: {
    iconOnly?: boolean;
} = {}) {
    const { state, dispatch } = useStore();
    const [aboutOpen, setAboutOpen] = useState(false);
    const triggerRef = useRef<HTMLSpanElement>(null);
    const name = profileLabel(state.config?.profile);
    const items = profileMenuItems({
        usage: true,
        onUsage: () => dispatch({ type: "toggleAppSettings", open: true, section: "usage" }),
        onApps: () => dispatch({ type: "togglePlugins", open: true }),
        onSettings: () => dispatch({ type: "toggleAppSettings" }),
        onShortcuts: () => {
            triggerRef.current?.closest("button")?.focus();
            dispatch({ type: "toggleShortcuts", open: true });
        },
        onAbout: () => setAboutOpen(true),
    });
    return (<>
      <SidebarPopoverMenu items={items} ariaLabel={name} triggerClassName={iconOnly ? "shrink-0 rounded-xl" : "w-full"} triggerTitle={iconOnly ? name : undefined} renderTrigger={({ open }) => iconOnly ? (<span ref={triggerRef} className={cn("relative flex size-[46px] items-center justify-center rounded-xl transition-colors", open ? "bg-raised" : "hover:bg-raised/50")}>
            <InitialsAvatar initials={profileInitials(state.config?.profile)} size={28}/>
          </span>) : (<span ref={triggerRef} className={cn("flex min-h-[46px] w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors", open ? "bg-raised" : "hover:bg-raised/50")}>
            <InitialsAvatar initials={profileInitials(state.config?.profile)} size={28}/>
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium leading-5 text-ink">{name}</span>
          </span>)}/>
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)}/>
    </>);
}
