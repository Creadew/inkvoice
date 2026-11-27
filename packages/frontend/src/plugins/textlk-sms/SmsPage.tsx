// SMS page: compose a custom message to customers or raw numbers, and review
// the delivery log of every SMS (automatic and custom) with retry for
// failures. Wrapped in PluginGuard, so it only renders while enabled.

import { MessageSquare, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { canUser } from "@/hooks/use-can";
import { useTranslation } from "@/i18n";
import { useAuthStore } from "@/stores/auth.store";
import { type SmsLogRow, type SmsRecipient, smsApi, smsSegments } from "./api";

const PAGE_SIZE = 25;

function statusVariant(status: SmsLogRow["status"]) {
  if (status === "sent") return "default" as const;
  if (status === "failed") return "destructive" as const;
  return "secondary" as const;
}

export default function SmsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const canSend = canUser(user, "invoices", "publish");
  const canConfigure = canUser(user, "settings", "update");

  const [configured, setConfigured] = useState<boolean | null>(null);
  const [recipients, setRecipients] = useState<SmsRecipient[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [numbers, setNumbers] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  const [rows, setRows] = useState<SmsLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("all");
  const [offset, setOffset] = useState(0);

  const loadLog = useCallback(() => {
    smsApi
      .log({ status: status === "all" ? undefined : status, limit: PAGE_SIZE, offset })
      .then((r) => {
        setRows(r.data.rows);
        setTotal(r.data.total);
      })
      .catch((e) => toast.error((e as Error).message));
  }, [status, offset]);

  useEffect(() => {
    loadLog();
  }, [loadLog]);

  useEffect(() => {
    smsApi
      .getConfig()
      .then((r) => setConfigured(r.data.api_token_set && r.data.sender_id !== ""))
      // Users without settings access cannot read config; let the send decide.
      .catch(() => setConfigured(true));
    smsApi
      .recipients()
      .then((r) => setRecipients(r.data))
      .catch(() => setRecipients([]));
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return recipients;
    return recipients.filter((r) => r.name.toLowerCase().includes(q) || r.phone.includes(q));
  }, [recipients, search]);

  const seg = smsSegments(message);

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };

  const send = async () => {
    const numberList = numbers
      .split(/[,;\n]/)
      .map((n) => n.trim())
      .filter(Boolean);
    if (selected.size === 0 && numberList.length === 0) {
      toast.error(t("textlk_sms.no_recipients"));
      return;
    }
    setSending(true);
    try {
      const res = await smsApi.send({
        customer_ids: [...selected],
        numbers: numberList,
        message,
      });
      const failed = res.data.filter((r) => r.status !== "sent").length;
      const ok = res.data.length - failed;
      if (ok > 0) toast.success(t("textlk_sms.sent_toast", { count: ok }));
      if (failed > 0) toast.error(t("textlk_sms.failed_toast", { count: failed }));
      if (failed === 0) {
        setSelected(new Set());
        setNumbers("");
        setMessage("");
      }
      setOffset(0);
      loadLog();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const retry = async (id: string) => {
    try {
      const res = await smsApi.retry(id);
      if (res.data.status === "sent") toast.success(t("textlk_sms.retried"));
      else toast.error(res.data.error ?? t("textlk_sms.status_failed"));
      loadLog();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <MessageSquare className="h-6 w-6" />
          {t("textlk_sms.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("textlk_sms.subtitle")}</p>
      </div>

      {configured === false && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4 text-sm">
            <span>{t("textlk_sms.not_configured")}</span>
            {canConfigure && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => navigate("/settings/plugins/textlk-sms")}
              >
                {t("textlk_sms.configure")}
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {canSend && configured && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("textlk_sms.compose")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label>{t("textlk_sms.customers")}</Label>
                  {selected.size > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {t("textlk_sms.selected_count", { count: selected.size })}
                    </span>
                  )}
                </div>
                <Input
                  placeholder={t("textlk_sms.search_customers")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <div className="max-h-48 overflow-y-auto rounded-md border">
                  {filtered.length === 0 ? (
                    <p className="p-3 text-sm text-muted-foreground">
                      {t("textlk_sms.no_customers")}
                    </p>
                  ) : (
                    filtered.map((r) => (
                      <label
                        key={r.id}
                        htmlFor={`sms-customer-${r.id}`}
                        className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted"
                      >
                        <Checkbox
                          id={`sms-customer-${r.id}`}
                          checked={selected.has(r.id)}
                          onCheckedChange={(v) => toggle(r.id, v === true)}
                        />
                        <span className="flex-1 truncate">{r.name}</span>
                        <span className="text-xs text-muted-foreground">{r.phone}</span>
                      </label>
                    ))
                  )}
                </div>
              </div>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="sms-numbers">{t("textlk_sms.numbers")}</Label>
                  <Input
                    id="sms-numbers"
                    value={numbers}
                    onChange={(e) => setNumbers(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">{t("textlk_sms.numbers_hint")}</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sms-message">{t("textlk_sms.message")}</Label>
                  <Textarea
                    id="sms-message"
                    rows={4}
                    maxLength={1000}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("textlk_sms.message_hint")} ·{" "}
                    {t("textlk_sms.counter", { chars: seg.chars, parts: seg.parts })}
                  </p>
                  {seg.unicode && (
                    <p className="text-xs text-amber-600">{t("textlk_sms.unicode_note")}</p>
                  )}
                </div>
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={send} disabled={sending || !message.trim()}>
                {sending ? t("textlk_sms.sending") : t("textlk_sms.send")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">{t("textlk_sms.log")}</CardTitle>
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v ?? "all");
              setOffset(0);
            }}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("textlk_sms.all_statuses")}</SelectItem>
              <SelectItem value="sent">{t("textlk_sms.status_sent")}</SelectItem>
              <SelectItem value="failed">{t("textlk_sms.status_failed")}</SelectItem>
              <SelectItem value="pending">{t("textlk_sms.status_pending")}</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("textlk_sms.no_log")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("textlk_sms.col_date")}</TableHead>
                    <TableHead>{t("textlk_sms.col_recipient")}</TableHead>
                    <TableHead>{t("textlk_sms.col_type")}</TableHead>
                    <TableHead>{t("textlk_sms.col_message")}</TableHead>
                    <TableHead>{t("textlk_sms.col_status")}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="whitespace-nowrap text-xs">
                        {new Date(`${row.created_at.replace(" ", "T")}Z`).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-sm">
                        <div>{row.customer_name ?? row.recipient}</div>
                        {row.customer_name && (
                          <div className="text-xs text-muted-foreground">{row.recipient}</div>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {t(`textlk_sms.event_${row.event}`)}
                        {row.invoice_id && row.invoice_number && (
                          <Link
                            to={`/invoices/${row.invoice_id}`}
                            className="block text-primary hover:underline"
                          >
                            {row.invoice_number}
                          </Link>
                        )}
                      </TableCell>
                      <TableCell className="max-w-md text-xs">
                        <div className="line-clamp-3" title={row.message}>
                          {row.message}
                        </div>
                        {row.error && <div className="text-destructive">{row.error}</div>}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(row.status)}>
                          {t(`textlk_sms.status_${row.status}`)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {row.status === "failed" && canSend && (
                          <Button size="sm" variant="ghost" onClick={() => retry(row.id)}>
                            <RotateCcw className="mr-1 h-3.5 w-3.5" />
                            {t("textlk_sms.retry")}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-end gap-2 pt-4">
              <Button
                size="sm"
                variant="outline"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                {t("textlk_sms.previous")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                {t("textlk_sms.next")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
