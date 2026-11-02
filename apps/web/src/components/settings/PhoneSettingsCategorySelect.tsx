import { useLocation, useNavigate } from "@tanstack/react-router";
import { SETTINGS_SECTION_LABELS, type SettingsPath } from "./settingsSearch";

const categories = Object.entries(SETTINGS_SECTION_LABELS) as Array<[SettingsPath, string]>;

export function PhoneSettingsCategorySelect() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const selected = categories.find(
    ([path]) => pathname === path || pathname.startsWith(`${path}/`),
  );

  return (
    <select
      aria-label="Settings category"
      className="min-h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      value={selected?.[0] ?? ""}
      onChange={(event) => {
        const category = categories.find(([path]) => path === event.currentTarget.value);
        if (category) {
          void navigate({ to: category[0], hash: "", replace: true, hashScrollIntoView: false });
        }
      }}
    >
      {!selected ? (
        <option value="" disabled>
          Settings
        </option>
      ) : null}
      {categories.map(([path, label]) => (
        <option key={path} value={path}>
          {label}
        </option>
      ))}
    </select>
  );
}
