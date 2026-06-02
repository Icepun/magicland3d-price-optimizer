"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { toast } from "sonner";
import {
  Layers,
  Plus,
  X,
  Search,
  Unlink,
  Package,
  ArrowUpRight,
  Check,
  Pencil,
  FolderPlus,
  Trash2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, cn } from "@/lib/utils";

interface VMember {
  id: string;
  name: string;
  variantLabel: string | null;
  imageUrl: string | null;
  stock: number;
  currentSalePrice: number;
}
export interface VariantGroupData {
  id: string;
  name: string;
  products: VMember[];
}
interface PickProduct {
  id: string;
  name: string;
  imageUrl: string | null;
  currentSalePrice: number;
  variantGroup: { id: string; name: string } | null;
}
/** ["product", productId] detay cache'inin optimistic güncelleme için kullanılan kısmı. */
type DetailCache = {
  variantGroup?: { id: string; name: string; products?: VMember[] } | null;
} & Record<string, unknown>;

function Thumb({ src, className }: { src: string | null; className?: string }) {
  return (
    <div className={cn("h-9 w-9 shrink-0 rounded-md border bg-muted flex items-center justify-center overflow-hidden", className)}>
      {src ? (
        <img src={src} alt="" className="max-w-full max-h-full object-contain" loading="lazy" />
      ) : (
        <Package className="h-4 w-4 text-muted-foreground/40" />
      )}
    </div>
  );
}

export function VariantsCard({
  productId,
  productName,
  group,
}: {
  productId: string;
  productName: string;
  group: VariantGroupData | null;
}) {
  const qc = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(group?.name ?? "");
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [confirmDissolve, setConfirmDissolve] = useState(false);
  const [confirmUnlinkId, setConfirmUnlinkId] = useState<string | null>(null);

  const refresh = () => {
    // SADECE bu ürünü tazele (prefix ["product"] DEĞİL → diğer ürün cache'lerini boşuna bayatlatma).
    // Üyelik değişen işlemler (unlink/dissolve) için bu ürünün refetch'i gerekli; liste lazy.
    qc.invalidateQueries({ queryKey: ["product", productId] });
    qc.invalidateQueries({ queryKey: ["products"], refetchType: "none" });
  };

  const renameGroup = useMutation({
    mutationFn: (name: string) =>
      fetch(`/api/variant-groups/${group!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }).then((r) => {
        if (!r.ok) throw new Error("Güncellenemedi");
        return r.json();
      }),
    // Optimistic: editörü anında kapat + grup adını cache'te anında değiştir.
    onMutate: async (name: string) => {
      setEditingName(false);
      await qc.cancelQueries({ queryKey: ["product", productId] });
      const prev = qc.getQueryData<DetailCache>(["product", productId]);
      qc.setQueryData<DetailCache>(["product", productId], (old) =>
        old?.variantGroup ? { ...old, variantGroup: { ...old.variantGroup, name } } : old
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["product", productId], ctx.prev);
      toast.error("Grup adı güncellenemedi (geri alındı)");
    },
    onSuccess: () => toast.success("Grup adı güncellendi"),
    // Optimistic onMutate zaten cache'i yamaladı → ürünü refetch etme; liste sadece bayat işaretlenir.
    onSettled: () => qc.invalidateQueries({ queryKey: ["products"], refetchType: "none" }),
  });

  const unlink = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/products/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantGroupId: null, variantLabel: null }),
      }).then((r) => r.json()),
    onSuccess: () => {
      refresh();
      toast.success("Varyant gruptan çıkarıldı");
    },
    onError: () => toast.error("İşlem başarısız"),
  });

  const editLabel = useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) =>
      fetch(`/api/products/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantLabel: label.trim() || null }),
      }).then((r) => r.json()),
    // Optimistic: etiket editörünü anında kapat + üyenin etiketini cache'te anında değiştir.
    onMutate: async ({ id, label }) => {
      setEditingLabelId(null);
      await qc.cancelQueries({ queryKey: ["product", productId] });
      const prev = qc.getQueryData<DetailCache>(["product", productId]);
      qc.setQueryData<DetailCache>(["product", productId], (old) =>
        old?.variantGroup?.products
          ? {
              ...old,
              variantGroup: {
                ...old.variantGroup,
                products: old.variantGroup.products.map((p) =>
                  p.id === id ? { ...p, variantLabel: label.trim() || null } : p
                ),
              },
            }
          : old
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["product", productId], ctx.prev);
      toast.error("Etiket güncellenemedi (geri alındı)");
    },
    onSuccess: () => toast.success("Etiket güncellendi"),
    // Optimistic onMutate zaten cache'i yamaladı → ürünü refetch etme; liste sadece bayat işaretlenir.
    onSettled: () => qc.invalidateQueries({ queryKey: ["products"], refetchType: "none" }),
  });

  const dissolve = useMutation({
    mutationFn: () =>
      fetch(`/api/variant-groups/${group!.id}`, { method: "DELETE" }).then((r) => r.json()),
    onSuccess: () => {
      refresh();
      setConfirmDissolve(false);
      toast.success("Grup dağıtıldı");
    },
    onError: () => toast.error("İşlem başarısız"),
  });

  // ───────────────────────── Gruplanmamış ürün ─────────────────────────
  if (!group) {
    return (
      <Card className="animate-in fade-in slide-in-from-bottom-2 duration-500" style={{ animationDelay: "20ms", animationFillMode: "both" }}>
        <CardHeader className="pb-3 border-b border-border/50">
          <CardTitle className="text-sm flex items-center gap-2">
            <Layers className="h-4 w-4 text-primary" />
            Varyantlar
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-3 space-y-3">
          <p className="text-xs text-muted-foreground leading-relaxed">
            Bu ürünü bir <span className="font-medium text-foreground">varyant grubuna</span> ekleyerek aynı ürünün
            renk/boy seçeneklerini (Shopify&apos;dan ayrı çekilmiş ürünleri) tek genel başlık altında topla. Grup,
            ürünler listesinde tek satırda görünür; üyeler içinde açılır.
          </p>
          <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
            <FolderPlus className="h-4 w-4" /> Varyant Grubu Oluştur
          </Button>
        </CardContent>
        {createOpen && <CreateGroupModal productId={productId} productName={productName} onClose={() => setCreateOpen(false)} />}
      </Card>
    );
  }

  // ───────────────────────── Gruplu ürün ─────────────────────────
  const members = group.products;

  return (
    <Card className="animate-in fade-in slide-in-from-bottom-2 duration-500" style={{ animationDelay: "20ms", animationFillMode: "both" }}>
      <CardHeader className="pb-3 border-b border-border/50">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-2 min-w-0 flex-1">
            <Layers className="h-4 w-4 text-primary shrink-0" />
            {editingName ? (
              <span className="flex items-center gap-1.5 flex-1">
                <Input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  className="h-7 text-sm"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && nameDraft.trim()) renameGroup.mutate(nameDraft.trim());
                    if (e.key === "Escape") setEditingName(false);
                  }}
                />
                <button
                  className="p-1 rounded text-primary hover:bg-muted disabled:opacity-50"
                  disabled={!nameDraft.trim() || renameGroup.isPending}
                  onClick={() => renameGroup.mutate(nameDraft.trim())}
                >
                  <Check className="h-4 w-4" />
                </button>
                <button className="p-1 rounded text-muted-foreground hover:bg-muted" onClick={() => setEditingName(false)}>
                  <X className="h-4 w-4" />
                </button>
              </span>
            ) : (
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="truncate">{group.name}</span>
                <Badge variant="outline" className="ml-0.5 tabular-nums shrink-0">{members.length} varyant</Badge>
                <button
                  className="p-1 rounded text-muted-foreground/60 hover:text-foreground shrink-0"
                  title="Grup adını düzenle"
                  onClick={() => {
                    setNameDraft(group.name);
                    setEditingName(true);
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </span>
            )}
          </CardTitle>
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs shrink-0" onClick={() => setPickerOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> Varyant Ekle
          </Button>
        </div>
      </CardHeader>

      <CardContent className="pt-3 space-y-1.5">
        {members.map((m) => {
          const isCurrent = m.id === productId;
          return (
            <div
              key={m.id}
              className={cn(
                "flex items-center gap-2.5 py-1.5 px-1.5 rounded-lg",
                isCurrent && "bg-primary/5 ring-1 ring-primary/20"
              )}
            >
              <Thumb src={m.imageUrl} />
              <div className="min-w-0 flex-1">
                {editingLabelId === m.id ? (
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={labelDraft}
                      onChange={(e) => setLabelDraft(e.target.value)}
                      placeholder="Kırmızı / Büyük Boy…"
                      className="h-7 text-sm"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter") editLabel.mutate({ id: m.id, label: labelDraft });
                        if (e.key === "Escape") setEditingLabelId(null);
                      }}
                    />
                    <button className="p-1 rounded text-primary hover:bg-muted" onClick={() => editLabel.mutate({ id: m.id, label: labelDraft })}>
                      <Check className="h-4 w-4" />
                    </button>
                    <button className="p-1 rounded text-muted-foreground hover:bg-muted" onClick={() => setEditingLabelId(null)}>
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-medium truncate">{m.variantLabel || m.name}</p>
                      {isCurrent && <Badge className="h-4 px-1.5 text-[9px] shrink-0">bu ürün</Badge>}
                    </div>
                    {m.variantLabel && <p className="text-[10px] text-muted-foreground truncate">{m.name}</p>}
                  </>
                )}
              </div>

              {editingLabelId !== m.id && (
                <>
                  <div className="text-right shrink-0 tabular-nums">
                    <p className="text-xs font-medium">{formatCurrency(m.currentSalePrice)}</p>
                    <p className="text-[10px] text-muted-foreground">stok {m.stock}</p>
                  </div>
                  <button
                    onClick={() => {
                      setEditingLabelId(m.id);
                      setLabelDraft(m.variantLabel ?? "");
                    }}
                    className="shrink-0 p-1.5 rounded text-muted-foreground/60 hover:text-foreground"
                    title="Etiketi düzenle"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  {!isCurrent && (
                    <Link href={`/products/${m.id}`} className="shrink-0 p-1.5 rounded text-muted-foreground hover:text-foreground" title="Ürüne git">
                      <ArrowUpRight className="h-3.5 w-3.5" />
                    </Link>
                  )}
                  {confirmUnlinkId === m.id ? (
                    <span className="shrink-0 flex items-center gap-0.5">
                      <button
                        onClick={() => {
                          unlink.mutate(m.id);
                          setConfirmUnlinkId(null);
                        }}
                        disabled={unlink.isPending}
                        className="p-1.5 rounded text-destructive hover:bg-destructive/10 disabled:opacity-50"
                        title="Evet, gruptan çıkar"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => setConfirmUnlinkId(null)}
                        className="p-1.5 rounded text-muted-foreground hover:bg-muted"
                        title="Vazgeç"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirmUnlinkId(m.id)}
                      className="shrink-0 p-1.5 rounded text-muted-foreground/60 hover:text-destructive"
                      title="Gruptan çıkar"
                    >
                      <Unlink className="h-3.5 w-3.5" />
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}

        <div className="pt-2 mt-1 border-t border-border/50 flex items-center justify-end">
          {confirmDissolve ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Grubu dağıt? Üyeler ayrı ürünlere döner.</span>
              <Button size="sm" variant="destructive" className="h-7 text-xs" disabled={dissolve.isPending} onClick={() => dissolve.mutate()}>
                {dissolve.isPending ? "…" : "Evet, dağıt"}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setConfirmDissolve(false)}>
                Vazgeç
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs text-muted-foreground hover:text-destructive" onClick={() => setConfirmDissolve(true)}>
              <Trash2 className="h-3.5 w-3.5" /> Grubu Dağıt
            </Button>
          )}
        </div>
      </CardContent>

      {pickerOpen && (
        <VariantPicker
          groupId={group.id}
          groupName={group.name}
          excludeIds={members.map((m) => m.id)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </Card>
  );
}

// ───────────────────────── Yeni grup oluştur modal ─────────────────────────
function CreateGroupModal({ productId, productName, onClose }: { productId: string; productName: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(productName);
  const [label, setLabel] = useState("");

  const create = useMutation({
    mutationFn: () =>
      fetch("/api/variant-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), members: [{ productId, variantLabel: label.trim() || null }] }),
      }).then((r) => {
        if (!r.ok) throw new Error("Grup oluşturulamadı");
        return r.json();
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["product"] });
      qc.invalidateQueries({ queryKey: ["products"], refetchType: "none" });
      toast.success("Varyant grubu oluşturuldu");
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const modal = (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 animate-in fade-in" onClick={onClose} />
      <Card className="relative w-full max-w-md animate-in fade-in zoom-in-95 duration-200">
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Varyant Grubu Oluştur</h2>
            <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:bg-muted">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div>
            <Label className="text-xs">Genel grup adı</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="örn. Diş Macunu Sıkacağı" autoFocus />
            <p className="text-[10px] text-muted-foreground mt-1">Listede bu isim görünür. Renk/boy belirtmeden genel adı yaz.</p>
          </div>
          <div>
            <Label className="text-xs">Bu ürünün etiketi (örn. Sarı)</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Sarı / Büyük Boy… (boş bırakılabilir)" />
          </div>
          <div className="flex gap-2 pt-1">
            <Button className="flex-1 gap-1" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
              <Check className="h-4 w-4" /> {create.isPending ? "Oluşturuluyor…" : "Grubu Oluştur"}
            </Button>
            <Button variant="ghost" onClick={onClose}>İptal</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(modal, document.body) : null;
}

// ───────────────────────── Gruba üye ekle modal ─────────────────────────
function VariantPicker({
  groupId,
  groupName,
  excludeIds,
  onClose,
}: {
  groupId: string;
  groupName: string;
  excludeIds: string[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data } = useQuery<PickProduct[]>({
    queryKey: ["products", "variant-picker"],
    // lite=1: kâr hesabı olmadan hafif liste (ad/resim/fiyat) — picker'ı yormaz.
    queryFn: () => fetch("/api/products?filter=all&lite=1").then((r) => r.json()),
  });
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [selected, setSelected] = useState<PickProduct | null>(null);
  const [label, setLabel] = useState("");

  // Arama debounce: input anında yazılır (q), filtre 200ms sonra (debouncedQ) → her tuşta
  // 50 satırı yeniden süzme/render yok, yazma akıcı kalır.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 200);
    return () => clearTimeout(t);
  }, [q]);

  const exclude = useMemo(() => new Set(excludeIds), [excludeIds]);
  const list = useMemo(() => {
    const all = Array.isArray(data) ? data : [];
    const query = debouncedQ.trim().toLocaleLowerCase("tr-TR");
    return all
      .filter((p) => !exclude.has(p.id))
      .filter((p) => !query || p.name.toLocaleLowerCase("tr-TR").includes(query))
      .slice(0, 50);
  }, [data, debouncedQ, exclude]);

  const link = useMutation({
    mutationFn: () =>
      fetch(`/api/products/${selected!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantGroupId: groupId, variantLabel: label.trim() || null }),
      }).then((r) => {
        if (!r.ok) throw new Error("Bağlanamadı");
        return r.json();
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["product"] });
      qc.invalidateQueries({ queryKey: ["products"], refetchType: "none" });
      toast.success("Varyant gruba eklendi");
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const modal = (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 animate-in fade-in" onClick={onClose} />
      <Card className="relative w-full max-w-md animate-in fade-in zoom-in-95 duration-200">
        <CardContent className="p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Varyant Ekle</h2>
            <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:bg-muted">
              <X className="h-4 w-4" />
            </button>
          </div>

          {!selected ? (
            <>
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{groupName}</span> grubuna eklenecek ürünü seç:
              </p>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ürün ara…" className="pl-8 h-9" autoFocus />
              </div>
              <div className="max-h-72 overflow-y-auto -mx-1 px-1 space-y-0.5">
                {list.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-6">Eklenebilecek ürün bulunamadı.</p>
                ) : (
                  list.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setSelected(p)}
                      className="w-full flex items-center gap-2.5 p-1.5 rounded-lg hover:bg-muted text-left"
                    >
                      <Thumb src={p.imageUrl} />
                      <span className="flex-1 min-w-0 text-sm truncate">
                        {p.name}
                        {p.variantGroup && (
                          <span className="block text-[10px] text-amber-500 truncate">şu an: {p.variantGroup.name} — taşınır</span>
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums shrink-0">{formatCurrency(p.currentSalePrice)}</span>
                    </button>
                  ))
                )}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2.5 rounded-lg border bg-muted/30 p-2">
                <Thumb src={selected.imageUrl} />
                <span className="flex-1 min-w-0 text-sm font-medium truncate">{selected.name}</span>
                <button onClick={() => setSelected(null)} className="text-[11px] text-primary hover:underline shrink-0">değiştir</button>
              </div>
              <div>
                <Label className="text-xs">Varyant adı (örn. Kırmızı)</Label>
                <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Kırmızı / Büyük Boy…" autoFocus />
                <p className="text-[10px] text-muted-foreground mt-1">Boş bırakırsan ürün adı kullanılır.</p>
              </div>
              <div className="flex gap-2">
                <Button className="flex-1 gap-1" disabled={link.isPending} onClick={() => link.mutate()}>
                  <Check className="h-4 w-4" /> {link.isPending ? "Ekleniyor…" : "Gruba Ekle"}
                </Button>
                <Button variant="ghost" onClick={() => setSelected(null)}>Geri</Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(modal, document.body) : null;
}
