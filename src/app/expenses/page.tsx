"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Pencil, Plus, Receipt, RefreshCw, Repeat, Tags, Trash2, WalletCards } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { cn, formatCurrency } from "@/lib/utils";
import { KATEGORI_RENKLERI } from "@/lib/expense-admin-shared";
import {
  araliktakiler, aylaraGore, donemOzeti, kategoriAdi, kategoriDagilimi, periyotAraligi,
  type PeriyotTipi,
} from "@/lib/expense-view";
import { donemAnahtari } from "@/lib/recurring-expense";
import { KategoriGrafigi, OzetSerit, PeriyotSecici } from "./expense-ui";
import {
  KategoriYonetimi,
  SabitGiderYonetimi,
  type KategoriKaydi,
  type TekrarKaydi,
} from "./expense-admin-ui";

interface ActualExpense {
  id: string;
  name: string;
  category: string | null;
  amount: number;
  paidAt: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  /** Dolu ise bu kayıt tekrarlayan sabit gider kuralından OTOMATİK açıldı. */
  recurringId: string | null;
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
  kategoriler,
  onSubmit,
}: {
  initial?: ActualExpense | null;
  pending: boolean;
  kategoriler: KategoriKaydi[];
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
          {/* Kendi listenden seç ya da yeni bir ad yaz. `datalist` ikisine de izin verir;
              açılır kutu olsaydı listede olmayan bir kategori hiç girilemezdi. */}
          <Input
            id="expense-category"
            list="expense-category-options"
            maxLength={60}
            value={form.category}
            placeholder="Seç ya da yaz"
            onChange={(event) => update("category", event.target.value)}
          />
          <datalist id="expense-category-options">
            {kategoriler.map((k) => (
              <option key={k.id} value={k.name} />
            ))}
          </datalist>
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

  /** Kullanıcının kendi kategori listesi — grafikteki renkler buradan gelir. */
  const categoriesQuery = useQuery<KategoriKaydi[]>({
    queryKey: ["expense-categories"],
    queryFn: () => fetchJson<KategoriKaydi[]>("/api/expense-categories"),
    staleTime: 5 * 60_000,
  });
  const categories = useMemo(() => categoriesQuery.data ?? [], [categoriesQuery.data]);

  const [periyot, setPeriyot] = useState<PeriyotTipi>("ay");
  const [kategoriOpen, setKategoriOpen] = useState(false);
  const [tekrarOpen, setTekrarOpen] = useState(false);
  const [kategoriSuzgeci, setKategoriSuzgeci] = useState<string | null>(null);

  /**
   * Renk çözümü: önce kullanıcının kendi ataması, yoksa sıraya göre sabit bir renk.
   * Kategori adına bağlı olması önemli — sıraya bağlansaydı bir ay içinde harcama sırası
   * değişince aynı kategori başka renge kayardı.
   */
  const renkOf = useMemo(() => {
    const byName = new Map(categories.map((c) => [c.name, c.color]));
    return (kategori: string, sira: number) =>
      byName.get(kategori) ?? KATEGORI_RENKLERI[sira % KATEGORI_RENKLERI.length];
  }, [categories]);

  /**
   * "Şimdi" tek yerden gelir ve dakikada bir ilerler — Raporlar sayfasındaki desenle aynı.
   * Doğrudan `Date.now()` çağırmak render'ı saf olmaktan çıkarıyor (React Compiler uyarır)
   * ve gece yarısını geçen bir ekranda dönem sınırı güncellenmezdi.
   */
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const aralik = useMemo(() => periyotAraligi(periyot, nowMs), [periyot, nowMs]);
  const donemGiderleri = useMemo(
    () => araliktakiler(expenses, aralik.basMs, aralik.sonMs),
    [expenses, aralik]
  );
  const ozet = useMemo(() => donemOzeti(expenses, aralik), [expenses, aralik]);
  const dilimler = useMemo(
    () => kategoriDagilimi(donemGiderleri, renkOf),
    [donemGiderleri, renkOf]
  );
  /** Listede gösterilenler: dönem + (varsa) kategori süzgeci. */
  const gorunenler = useMemo(
    () =>
      kategoriSuzgeci
        ? donemGiderleri.filter((g) => kategoriAdi(g) === kategoriSuzgeci)
        : donemGiderleri,
    [donemGiderleri, kategoriSuzgeci]
  );
  const aylar = useMemo(() => aylaraGore(gorunenler), [gorunenler]);

  /**
   * Girilmiş ödemelerin "gider adı → hangi aylar" haritası.
   *
   * Sabit gider kuralına geçmiş bir başlangıç seçildiğinde çakışma uyarısı buradan çıkar:
   * veritabanındaki mükerrer koruması yalnız AYNI KURALIN aynı ayını engelliyor, elle
   * girilmiş bir kaydı tanımıyor. O ay iki kez sayılırsa net kâr sessizce düşerdi.
   */
  const girilmisDonemler = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const g of expenses) {
      const ms = Date.parse(g.paidAt);
      if (!Number.isFinite(ms)) continue;
      const ad = g.name.trim().toLocaleLowerCase("tr-TR");
      const set = map.get(ad) ?? new Set<string>();
      set.add(donemAnahtari(ms));
      map.set(ad, set);
    }
    return map;
  }, [expenses]);

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

  /**
   * Yenile — başka bir cihazda (telefon) girilen gider ya da vakti gelen sabit gider
   * bu ekrana düşsün. Gider listesi ucu aynı zamanda tekrarlayan giderleri de üretiyor,
   * yani düğme "yeni ay geldiyse sabit giderimi de aç" işini de görüyor.
   */
  const [yenileniyor, setYenileniyor] = useState(false);
  const yenile = async () => {
    if (yenileniyor) return;
    setYenileniyor(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["actual-expenses"] }),
        queryClient.invalidateQueries({ queryKey: ["expense-categories"] }),
        queryClient.invalidateQueries({ queryKey: ["recurring-expenses"] }),
        queryClient.invalidateQueries({ queryKey: ["finance-monthly"] }),
      ]);
    } finally {
      setYenileniyor(false);
    }
  };

  /** Tekrarlayan sabit gider kuralları. */
  const tekrarQuery = useQuery<TekrarKaydi[]>({
    queryKey: ["recurring-expenses"],
    queryFn: () => fetchJson<TekrarKaydi[]>("/api/recurring-expenses"),
    staleTime: 5 * 60_000,
  });

  const kategoriMutation = useMutation({
    mutationFn: (v: { method: "POST" | "DELETE"; id?: string; body?: unknown }) =>
      fetchJson(v.id ? `/api/expense-categories/${v.id}` : "/api/expense-categories", {
        method: v.method,
        headers: { "Content-Type": "application/json" },
        body: v.body ? JSON.stringify(v.body) : undefined,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["expense-categories"] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Kategori kaydedilemedi"),
  });

  const tekrarMutation = useMutation({
    mutationFn: (v: { method: "POST" | "DELETE"; id?: string; body?: unknown }) =>
      fetchJson(v.id ? `/api/recurring-expenses/${v.id}` : "/api/recurring-expenses", {
        method: v.method,
        headers: { "Content-Type": "application/json" },
        body: v.body ? JSON.stringify(v.body) : undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["recurring-expenses"] });
      // Yeni kural geçmiş ayları da kapsayabilir → gider listesi ve aylık kâr tazelensin.
      refreshFinance();
      toast.success("Sabit gider güncellendi");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Sabit gider kaydedilemedi"),
  });

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
            Her ödeme, yapıldığı ayın net kârından düşer.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void yenile()} disabled={yenileniyor}>
            <RefreshCw className={cn("h-4 w-4 mr-2", yenileniyor && "animate-spin")} />
            {yenileniyor ? "Yenileniyor…" : "Yenile"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setTekrarOpen(true)}>
            <Repeat className="h-4 w-4 mr-2" /> Sabit Giderler
          </Button>
          <Button variant="outline" size="sm" onClick={() => setKategoriOpen(true)}>
            <Tags className="h-4 w-4 mr-2" /> Kategoriler
          </Button>
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

      <PeriyotSecici value={periyot} onChange={setPeriyot} />

      <OzetSerit
        toplam={ozet.toplam}
        adet={ozet.adet}
        degisimYuzde={ozet.degisimYuzde}
        periyot={periyot}
      />

      {!query.isLoading && !query.isError && donemGiderleri.length > 0 && (
        <KategoriGrafigi
          dilimler={dilimler}
          toplam={ozet.toplam}
          secili={kategoriSuzgeci}
          onSec={setKategoriSuzgeci}
        />
      )}

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
        <div className="space-y-4">
          {/* Ay başlıklarıyla gruplu liste — hangi ayda ne kadar ödendiği başlıkta yazıyor,
              böylece kaydırırken "bu hangi ay" diye yukarı bakmak gerekmiyor. */}
          {aylar.map((ay, ai) => (
            <div key={ay.key} className="space-y-2">
              <div className="flex items-baseline justify-between gap-3 px-0.5">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {ay.label}
                </h2>
                <span className="text-sm font-bold tabular-nums">{formatCurrency(ay.toplam)}</span>
              </div>
              {ay.giderler.map((expense, i) => (
                <Card
                  key={expense.id}
                  className="transition-shadow hover:shadow-md animate-in fade-in slide-in-from-bottom-1 fill-mode-both duration-300"
                  style={{ animationDelay: `${Math.min(ai * 4 + i, 12) * 30}ms` }}
                >
                  <CardContent className="p-3 flex items-start gap-3">
                    <span
                      className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: renkOf(kategoriAdi(expense), 0) }}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium truncate">{expense.name}</p>
                        {/* Otomatik açılan kaydı işaretle: kullanıcı "bunu ben mi girdim"
                            diye tereddüt etmesin. */}
                        {expense.recurringId && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full border bg-primary/10 text-primary border-primary/30">
                            <Repeat className="h-3 w-3" /> sabit
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-0.5 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <CalendarDays className="h-3.5 w-3.5" />
                          {formatDate(expense.paidAt)}
                        </span>
                        <span>{kategoriAdi(expense)}</span>
                        {expense.note && <span className="truncate">{expense.note}</span>}
                      </div>
                    </div>
                    <p className="font-bold tabular-nums text-base shrink-0">
                      {formatCurrency(expense.amount)}
                    </p>
                    <div className="flex gap-0.5 shrink-0">
                      <Button
                        variant="ghost" size="icon" className="h-8 w-8" title="Düzenle"
                        onClick={() => setEditing(expense)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost" size="icon" className="h-8 w-8 text-destructive" title="Sil"
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
                  </CardContent>
                </Card>
              ))}
            </div>
          ))}
        </div>
      )}

      <Dialog open={kategoriOpen} onOpenChange={setKategoriOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Gider Kategorileri</DialogTitle>
          </DialogHeader>
          <KategoriYonetimi
            kategoriler={categories}
            pending={kategoriMutation.isPending}
            onEkle={(name, color) =>
              kategoriMutation.mutate({ method: "POST", body: { name, color } })
            }
            onSil={(id) => kategoriMutation.mutate({ method: "DELETE", id })}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={tekrarOpen} onOpenChange={setTekrarOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Her Ay Tekrarlayan Giderler</DialogTitle>
          </DialogHeader>
          <SabitGiderYonetimi
            kayitlar={tekrarQuery.data ?? []}
            kategoriler={categories}
            varOlanDonemler={girilmisDonemler}
            bugun={nowMs}
            pending={tekrarMutation.isPending}
            onEkle={(v) => tekrarMutation.mutate({ method: "POST", body: v })}
            onSil={(id) => tekrarMutation.mutate({ method: "DELETE", id })}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Yeni Gider Ödemesi</DialogTitle>
          </DialogHeader>
          <ExpenseForm
            key={createOpen ? "open" : "closed"}
            kategoriler={categories}
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
              kategoriler={categories}
              pending={updateMutation.isPending}
              onSubmit={(form) => updateMutation.mutate({ id: editing.id, form })}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
