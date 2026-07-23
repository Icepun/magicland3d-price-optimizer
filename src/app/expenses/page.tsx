"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Pencil, Plus, Receipt, Trash2, WalletCards } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchJson } from "@/lib/fetch-json";
import { formatCurrency } from "@/lib/utils";

interface ActualExpense {
  id: string;
  name: string;
  category: string | null;
  amount: number;
  paidAt: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ExpenseFormState {
  name: string;
  category: string;
  amount: string;
  paidAt: string;
  note: string;
}

const EMPTY_FORM: ExpenseFormState = {
  name: "",
  category: "",
  amount: "",
  paidAt: "",
  note: "",
};

function todayInputValue() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function paidAtInputValue(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return todayInputValue();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("tr-TR", {
        timeZone: "Europe/Istanbul",
        day: "2-digit",
        month: "long",
        year: "numeric",
      }).format(date);
}

function ExpenseForm({
  initial,
  pending,
  onSubmit,
}: {
  initial?: ActualExpense | null;
  pending: boolean;
  onSubmit: (value: ExpenseFormState) => void;
}) {
  const [form, setForm] = useState<ExpenseFormState>(() =>
    initial
      ? {
          name: initial.name,
          category: initial.category ?? "",
          amount: String(initial.amount),
          paidAt: paidAtInputValue(initial.paidAt),
          note: initial.note ?? "",
        }
      : { ...EMPTY_FORM, paidAt: todayInputValue() }
  );

  const amount = Number(form.amount);
  const valid =
    form.name.trim().length > 0 &&
    form.paidAt.length > 0 &&
    Number.isFinite(amount) &&
    amount > 0;

  function update<K extends keyof ExpenseFormState>(key: K, value: ExpenseFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSubmit(form);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Label htmlFor="expense-name">Gider adı *</Label>
          <Input
            id="expense-name"
            autoFocus
            maxLength={120}
            value={form.name}
            placeholder="Örn. yazılım aboneliği"
            onChange={(event) => update("name", event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="expense-amount">Tutar (TL) *</Label>
          <Input
            id="expense-amount"
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            value={form.amount}
            placeholder="0,00"
            onChange={(event) => update("amount", event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="expense-date">Ödeme tarihi *</Label>
          <Input
            id="expense-date"
            type="date"
            value={form.paidAt}
            onChange={(event) => update("paidAt", event.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="expense-category">Kategori</Label>
          <Input
            id="expense-category"
            maxLength={60}
            value={form.category}
            placeholder="Örn. Yazılım"
            onChange={(event) => update("category", event.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="expense-note">Not</Label>
          <textarea
            id="expense-note"
            rows={3}
            maxLength={500}
            value={form.note}
            placeholder="İsteğe bağlı kısa not"
            onChange={(event) => update("note", event.target.value)}
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        </div>
      </div>
      <DialogFooter>
        <Button type="submit" disabled={!valid || pending}>
          {pending ? "Kaydediliyor..." : initial ? "Değişiklikleri Kaydet" : "Gideri Kaydet"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export default function ExpensesPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ActualExpense | null>(null);

  const query = useQuery<ActualExpense[]>({
    queryKey: ["actual-expenses"],
    queryFn: async () => {
      const response = await fetchJson<ActualExpense[] | { expenses: ActualExpense[] }>(
        "/api/actual-expenses"
      );
      return Array.isArray(response) ? response : response.expenses;
    },
    staleTime: 30_000,
  });

  const expenses = useMemo(
    () => [...(query.data ?? [])].sort((a, b) => +new Date(b.paidAt) - +new Date(a.paidAt)),
    [query.data]
  );
  const total = useMemo(
    () => expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0),
    [expenses]
  );

  function payload(form: ExpenseFormState) {
    return {
      name: form.name.trim(),
      category: form.category.trim() || null,
      amount: Number(form.amount),
      paidAt: `${form.paidAt}T00:00:00+03:00`,
      note: form.note.trim() || null,
    };
  }

  function refreshFinance() {
    queryClient.invalidateQueries({ queryKey: ["actual-expenses"] });
    queryClient.invalidateQueries({ queryKey: ["finance-monthly"] });
  }

  const createMutation = useMutation({
    mutationFn: (form: ExpenseFormState) =>
      fetchJson<ActualExpense>("/api/actual-expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload(form)),
      }),
    onSuccess: () => {
      refreshFinance();
      setCreateOpen(false);
      toast.success("Gider kaydedildi");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Gider kaydedilemedi"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, form }: { id: string; form: ExpenseFormState }) =>
      fetchJson<ActualExpense>(`/api/actual-expenses/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload(form)),
      }),
    onSuccess: () => {
      refreshFinance();
      setEditing(null);
      toast.success("Gider güncellendi");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Gider güncellenemedi"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/actual-expenses/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      refreshFinance();
      toast.success("Gider silindi");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Gider silinemedi"),
  });

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-5xl">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <WalletCards className="h-6 w-6 text-primary" /> Gider Ödemeleri
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Bu kayıtlar siparişlere dağıtılmaz; yalnız seçtiğin ayın net kârından düşer.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/expense-rules"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Satış Gider Kuralları
          </Link>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-2" /> Yeni Gider
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Kayıtlı toplam ödeme</p>
            <p className="text-2xl font-bold tabular-nums mt-1">{formatCurrency(total)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Gider kaydı</p>
            <p className="text-2xl font-bold tabular-nums mt-1">{expenses.length}</p>
          </CardContent>
        </Card>
      </div>

      {query.isLoading ? (
        <div className="grid gap-3">
          {[1, 2, 3].map((item) => (
            <Skeleton key={item} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : query.isError ? (
        <Card className="border-destructive/40">
          <CardContent className="p-6 text-center space-y-3">
            <p className="text-sm text-destructive">Gider kayıtları alınamadı.</p>
            <Button variant="outline" size="sm" onClick={() => query.refetch()}>
              Yeniden Dene
            </Button>
          </CardContent>
        </Card>
      ) : expenses.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title="Henüz gider ödemesi yok"
          description="Ödeme yaptıkça tarih ve tutarıyla kaydet; ilgili ayın net kârından otomatik düşsün."
          action={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-2" /> İlk Gideri Ekle
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3">
          {expenses.map((expense) => (
            <Card key={expense.id}>
              <CardHeader className="p-4 pb-2">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <CardTitle className="text-sm truncate">{expense.name}</CardTitle>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <CalendarDays className="h-3.5 w-3.5" />
                        {formatDate(expense.paidAt)}
                      </span>
                      {expense.category && <span>{expense.category}</span>}
                    </div>
                  </div>
                  <p className="font-bold tabular-nums text-base shrink-0">
                    {formatCurrency(expense.amount)}
                  </p>
                </div>
              </CardHeader>
              <CardContent className="p-4 pt-1">
                <div className="flex items-end gap-3">
                  <p className="text-sm text-muted-foreground flex-1 min-w-0 break-words">
                    {expense.note || "Not eklenmedi."}
                  </p>
                  <div className="flex gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      title="Düzenle"
                      onClick={() => setEditing(expense)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive"
                      title="Sil"
                      disabled={deleteMutation.isPending}
                      onClick={() => {
                        if (window.confirm(`"${expense.name}" giderini silmek istiyor musun?`)) {
                          deleteMutation.mutate(expense.id);
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Yeni Gider Ödemesi</DialogTitle>
          </DialogHeader>
          <ExpenseForm
            key={createOpen ? "open" : "closed"}
            pending={createMutation.isPending}
            onSubmit={(form) => createMutation.mutate(form)}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Gideri Düzenle</DialogTitle>
          </DialogHeader>
          {editing && (
            <ExpenseForm
              key={editing.id}
              initial={editing}
              pending={updateMutation.isPending}
              onSubmit={(form) => updateMutation.mutate({ id: editing.id, form })}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
