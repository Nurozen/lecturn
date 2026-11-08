import type { ClerkProviderProps } from "@clerk/react";

// Scoped to auth flows: UserProfile reuses formButtonPrimary for destructive confirmations.
const authFlowElements = {
  formButtonPrimary:
    "redesign:border-primary redesign:bg-primary redesign:bg-none redesign:text-primary-foreground redesign:shadow-xs redesign:shadow-primary/24 redesign:hover:bg-primary/90 redesign:focus-visible:ring-2 redesign:focus-visible:ring-inset redesign:focus-visible:ring-ring redesign:focus-visible:ring-offset-1 redesign:focus-visible:ring-offset-background",
};

export const clerkAppearance = {
  // index.css orders this layer below components and utilities so the element classes below win.
  cssLayerName: "clerk",
  variables: {
    // Clerk reuses its primary color for filled buttons and bare links.
    colorPrimary: "var(--update-foreground)",
    colorPrimaryForeground: "var(--card)",
    colorDanger: "var(--error)",
    colorSuccess: "var(--success)",
    colorWarning: "var(--warning)",
    colorNeutral: "var(--contrast-foreground)",
    colorForeground: "var(--contrast-foreground)",
    // Clerk's muted token fills the footer; derive an opaque surface instead of stock dark translucency.
    colorMuted: "color-mix(in srgb, var(--card) 98%, var(--contrast-foreground))",
    colorMutedForeground: "var(--contrast-muted-foreground)",
    colorBackground: "var(--card)",
    colorInputForeground: "var(--contrast-foreground)",
    colorInput: "var(--secondary)",
    colorRing: "var(--ring)",
  },
  // The dialog-style card is the new design's; the Lecturn look keeps Clerk's own card.
  elements: {
    modalBackdrop: "redesign:dialog-backdrop",
    cardBox: "redesign:dialog-glass redesign:rounded-2xl redesign:border",
    card: "redesign:border-0 redesign:bg-transparent redesign:shadow-none",
    footer: "redesign:bg-transparent redesign:bg-none",
    header: "redesign:items-start redesign:text-start",
    headerTitle: "redesign:text-xl redesign:font-semibold",
    headerSubtitle: "redesign:text-sm redesign:text-muted-foreground",
    buttonArrowIcon: "redesign:hidden",
    formFieldErrorText: { color: "var(--error-foreground)" },
    formFieldWarningText: { color: "var(--warning-foreground)" },
    formFieldSuccessText: { color: "var(--success-foreground)" },
    otpCodeFieldErrorText: { color: "var(--error-foreground)" },
    otpCodeFieldSuccessText: { color: "var(--success-foreground)" },
  },
  signIn: { elements: authFlowElements },
  signUp: { elements: authFlowElements },
} satisfies NonNullable<ClerkProviderProps["appearance"]>;
