import { Copy, Download } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useTranslation } from "@/i18n";

interface Props {
  codes: string[];
  /** The user has saved the codes: start the session. */
  onDone: () => void;
}

/**
 * The recovery codes issued when the authenticator app was just set up. This
 * is the only time they are shown: the server keeps only their hashes.
 */
export function RecoveryCodes({ codes, onDone }: Props) {
  const { t } = useTranslation();
  const savedId = useId();
  const [saved, setSaved] = useState(false);
  const text = codes.join("\n");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("auth.recovery_codes_copied"));
    } catch {
      toast.error(t("auth.recovery_codes_copy_failed"));
    }
  };

  const download = () => {
    const blob = new Blob([`${t("auth.recovery_codes_file_header")}\n\n${text}\n`], {
      type: "text/plain",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "inkvoice-recovery-codes.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("auth.recovery_codes_info")}</p>
      <ul className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-3 text-center font-mono text-sm">
        {codes.map((code) => (
          <li key={code} className="select-all">
            {code}
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant="outline" onClick={copy}>
          <Copy className="h-4 w-4" />
          {t("auth.recovery_codes_copy")}
        </Button>
        <Button type="button" variant="outline" onClick={download}>
          <Download className="h-4 w-4" />
          {t("auth.recovery_codes_download")}
        </Button>
      </div>
      <label className="flex items-center gap-2 text-sm" htmlFor={savedId}>
        <Checkbox id={savedId} checked={saved} onCheckedChange={setSaved} />
        {t("auth.recovery_codes_saved")}
      </label>
      <Button type="button" className="w-full" disabled={!saved} onClick={onDone}>
        {t("auth.recovery_codes_continue")}
      </Button>
    </div>
  );
}
