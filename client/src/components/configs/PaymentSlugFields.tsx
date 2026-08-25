import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PAYMENT_SLUG_OPTIONS,
  normalizePaymentMethodSlug,
  parsePaymentMethodAliases,
} from "@shared/payment-method-aliases";

type PaymentSlugFieldsProps = {
  settings: Record<string, any> | undefined;
  onSettingChange: (key: string, value: any) => void;
};

const formatPaymentAliases = (value: unknown) =>
  parsePaymentMethodAliases(value).join(", ");

export function PaymentSlugFields({ settings, onSettingChange }: PaymentSlugFieldsProps) {
  const aliases = parsePaymentMethodAliases(settings?.paymentMethodAliases);
  const resolvedSlug =
    normalizePaymentMethodSlug(settings?.wcPaySlug) ||
    aliases.map((alias) => normalizePaymentMethodSlug(alias)).find(Boolean) ||
    "";
  const selectedPaymentSlugValue =
    normalizePaymentMethodSlug(settings?.wcPaySlug) ||
    (typeof settings?.wcPaySlug === "string" && settings.wcPaySlug.trim()
      ? settings.wcPaySlug.trim()
      : "_custom_");

  return (
    <div className="space-y-1.5">
      <Label className="text-[10px] font-mono uppercase text-muted-foreground">Payment Slug</Label>
      <Select
        value={selectedPaymentSlugValue}
        onValueChange={(value) =>
          onSettingChange("wcPaySlug", value === "_custom_" ? settings?.wcPaySlug || undefined : value)
        }
      >
        <SelectTrigger className="rounded-none border-primary/20 h-7 text-xs bg-black/20">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="_custom_">Custom / alias-driven</SelectItem>
          {PAYMENT_SLUG_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.value} ({option.label})
            </SelectItem>
          ))}
          {selectedPaymentSlugValue !== "_custom_" &&
            !PAYMENT_SLUG_OPTIONS.some((option) => option.value === selectedPaymentSlugValue) && (
              <SelectItem value={selectedPaymentSlugValue}>
                {selectedPaymentSlugValue} (custom)
              </SelectItem>
            )}
        </SelectContent>
      </Select>

      <div className="grid grid-cols-1 gap-2 pt-2">
        <Input
          value={(settings?.wcPaySlug || "") as string}
          onChange={(event) => onSettingChange("wcPaySlug", event.target.value || undefined)}
          placeholder="Canonical slug or alias, e.g. stripe_cc, wcpay"
          className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-black/20"
        />
        <Input
          value={formatPaymentAliases(settings?.paymentMethodAliases)}
          onChange={(event) => onSettingChange("paymentMethodAliases", parsePaymentMethodAliases(event.target.value))}
          placeholder="Fallback aliases, comma-separated"
          className="rounded-none border-primary/20 font-mono text-[10px] h-7 bg-black/20"
        />
      </div>

      <div className="rounded-none border border-primary/10 bg-black/15 p-2.5 space-y-2">
        <div className="flex flex-wrap gap-1.5">
          {PAYMENT_SLUG_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onSettingChange("wcPaySlug", option.value)}
              className={`rounded-none border px-2 py-1 text-[9px] font-mono transition-colors ${
                resolvedSlug === option.value
                  ? "border-cyan-400/50 bg-cyan-500/10 text-cyan-300"
                  : "border-primary/15 bg-black/20 text-muted-foreground hover:border-primary/30 hover:text-foreground"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[9px] font-mono">
          <span className="text-cyan-400/80">Resolved slug:</span>
          <Badge variant="outline" className="rounded-none border-cyan-500/20 bg-cyan-500/5 text-cyan-300">
            {resolvedSlug || "auto-detect"}
          </Badge>
        </div>

        {aliases.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {aliases.map((alias) => (
              <Badge key={alias} variant="outline" className="rounded-none border-primary/15 bg-black/10 text-[9px] font-mono">
                {alias}
              </Badge>
            ))}
          </div>
        )}

        <p className="text-[9px] text-muted-foreground/60 font-mono">
          Presets save canonical slugs. Custom input accepts either the canonical slug or a familiar alias, and aliases are normalized when the gate is saved.
        </p>
      </div>
    </div>
  );
}
