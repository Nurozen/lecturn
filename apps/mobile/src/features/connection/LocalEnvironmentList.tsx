import type { EnvironmentId } from "@lecturn/contracts";
import type { ComponentProps } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { GlassCard } from "../../components/GlassCard";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { ConnectionEnvironmentRow } from "./ConnectionEnvironmentRow";

type EnvironmentRowProps = ComponentProps<typeof ConnectionEnvironmentRow>;

/** Shared list and empty state for environment management entry points. */
export function LocalEnvironmentList({
  environments,
  expandedId,
  onToggle,
  onAdd,
  ...rowActions
}: Pick<EnvironmentRowProps, "onReconnect" | "onRemove" | "onSetEnabled" | "onUpdate"> & {
  readonly environments: ReadonlyArray<EnvironmentRowProps["environment"]>;
  readonly expandedId: EnvironmentId | null;
  readonly onToggle: (environmentId: EnvironmentId) => void;
  /** Shows an explicit add button in the empty state instead of pointing at the header. */
  readonly onAdd?: () => void;
}) {
  if (environments.length === 0) {
    return (
      <GlassCard collapsable={false} radius={24} className="items-center gap-3 px-6 py-8">
        <View className="h-12 w-12 items-center justify-center rounded-[16px] bg-subtle">
          <SymbolView
            name="point.3.connected.trianglepath.dotted"
            size={20}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        </View>
        {onAdd ? (
          <>
            <Text className="text-center text-sm leading-normal text-foreground-muted">
              No environments connected yet.
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add environment"
              className="min-h-11 items-center justify-center rounded-xl bg-subtle px-5 py-3"
              onPress={onAdd}
            >
              <Text className="font-lecturn-bold text-foreground">Add environment</Text>
            </Pressable>
          </>
        ) : (
          <Text className="text-center text-sm leading-normal text-foreground-muted">
            No environments connected yet.{"\n"}Tap{" "}
            <Text className="font-lecturn-bold text-foreground">+</Text> to add one.
          </Text>
        )}
      </GlassCard>
    );
  }

  return (
    <GlassCard collapsable={false} radius={24} className="overflow-hidden">
      {environments.map((environment, index) => (
        <View
          key={environment.environmentId}
          collapsable={false}
          className={cn(index !== 0 && "border-t border-border")}
        >
          <ConnectionEnvironmentRow
            environment={environment}
            expanded={expandedId === environment.environmentId}
            onToggle={() => onToggle(environment.environmentId)}
            {...rowActions}
          />
        </View>
      ))}
    </GlassCard>
  );
}
