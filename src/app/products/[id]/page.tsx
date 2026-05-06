"use client";

import { use, useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { ArrowLeft, Zap, TrendingUp, Target, Package } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import Link from "next/link";
import { toast } from "sonner";
import type { RecommendationOutput, SimulationResult } from "@/core/types";

interface FilamentType {
  id: string;
  name: string;
  costPerGram: number;
  isActive: boolean;
}

interface ProductDetail {
  id: string;
  barcode: string;
  sku: string;
  name: string;
  categoryName: string;
  currentSalePrice: number;
  listPrice: number | null;
  stock: number;
  desi: number | null;
  weight: number | null;
  imageUrl: string | null;
  source: string;
  cost: {
    costMode: string;
    manualCost: number | null;
    packagingCost: number | null;
    materialWeight: number | null;
    printTimeHours: number | null;
    totalCost: number | null;
    filamentTypeId: string | null;
    filamentWeight: number | null;
    wasteRate: number | null;
    packagingPoset: number | null;
    packagingNaylon: number | null;
    packagingBant: number | null;
    packagingKart: number | null;
    filamentType?: FilamentType | null;
  } | null;
}

interface SimulationResponse {
  product: {
    id: string;
    name: string;
    currentSalePrice: number;
    productCost: number;
    packagingCost: number;
  };
  recommendations: RecommendationOutput;
}

const PIE_COLORS = ["#ef4444", "#3b82f6", "#f59e0b", "#8b5cf6", "#10b981", "#22c55e"];

function DeductionsPie({ result }: { result: SimulationResult }) {
  const data = [
    { name: "Ürün Maliyeti", value: result.productCost },
    { name: "Komisyon", value: result.commissionCost },
    { name: "Kargo", value: result.cargoCost },
    { name: "Sabit Gider", value: result.fixedExpenses },
    { name: "Değişken Gider", value: result.variableExpenses },
    { name: "Net Kâr", value: Math.max(0, result.netProfit) },
  ].filter((d) => d.value > 0);

  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={55}
          outerRadius={85}
          dataKey="value"
          label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
          labelLine={false}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip formatter={(v: number) => formatCurrency(v)} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export default function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const queryClient = useQueryClient();

  const [selectedPrice, setSelectedPrice] = useState<number | null>(null);

  // Load product detail
  const { data: product, isLoading } = useQuery<ProductDetail>({
    queryKey: ["product", id],
    queryFn: () => fetch(`/api/products/${id}`).then((r) => r.json()),
  });

  // Load filaments
  const { data: filaments = [] } = useQuery<FilamentType[]>({
    queryKey: ["filament-types"],
    queryFn: () => fetch("/api/filament-types").then((r) => r.json()),
  });

  // Load global app settings
  const { data: globalSettings = {} } = useQuery<Record<string, string>>({
    queryKey: ["app-settings"],
    queryFn: () => fetch("/api/settings").then((r) => r.json()),
  });

  // Form states
  const [filamentTypeId, setFilamentTypeId] = useState("");
  const [filamentWeight, setFilamentWeight] = useState("");
  const [printTimeHours, setPrintTimeHours] = useState("");
  const [wasteRate, setWasteRate] = useState("");

  const [packagingPoset, setPackagingPoset] = useState("");
  const [packagingNaylon, setPackagingNaylon] = useState("");
  const [packagingBant, setPackagingBant] = useState("");
  const [packagingKart, setPackagingKart] = useState("");

  // Sync initial values when product is loaded
  useEffect(() => {
    if (product?.cost) {
      const c = product.cost;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFilamentTypeId(c.filamentTypeId || "");
      setFilamentWeight(c.filamentWeight ? String(c.filamentWeight) : "");
      setPrintTimeHours(c.printTimeHours ? String(c.printTimeHours) : "");
      setWasteRate(c.wasteRate ? String(Number(c.wasteRate) * 100) : "");

      setPackagingPoset(c.packagingPoset ? String(c.packagingPoset) : "");
      setPackagingNaylon(c.packagingNaylon ? String(c.packagingNaylon) : "");
      setPackagingBant(c.packagingBant ? String(c.packagingBant) : "");
      setPackagingKart(c.packagingKart ? String(c.packagingKart) : "");
    }
  }, [product]);

  // Real-time detailed cost preview calculation
  const selectedFilament = filaments.find((f) => f.id === filamentTypeId);
  const costPerGram = selectedFilament?.costPerGram || 0;
  const fWeight = parseFloat(filamentWeight) || 0;
  const pTime = parseFloat(printTimeHours) || 0;
  const wRate = (parseFloat(wasteRate) || 0) / 100;

  const pPoset = parseFloat(packagingPoset) || 0;
  const pNaylon = parseFloat(packagingNaylon) || 0;
  const pBant = parseFloat(packagingBant) || 0;
  const pKart = parseFloat(packagingKart) || 0;

  const electricityRate = parseFloat(globalSettings.costElectricityPerHour || "0");
  const machineWearRate = parseFloat(globalSettings.costMachineWearPerHour || "0");
  const laborRate = parseFloat(globalSettings.costLaborPerHour || "0");

  const calcFilamentCost = fWeight * costPerGram;
  const calcElectricityCost = pTime * electricityRate;
  const calcMachineWearCost = pTime * machineWearRate;
  const calcLaborCost = pTime * laborRate;
  const calcPackagingTotal = pPoset + pNaylon + pBant + pKart;

  const subtotal = calcFilamentCost + calcElectricityCost + calcMachineWearCost + calcLaborCost + calcPackagingTotal;
  const calcWasteCost = subtotal * wRate;
  const calculatedTotalCost = subtotal + calcWasteCost;

  const finalEffectiveTotalCost = calculatedTotalCost;

  const simulationMutation = useMutation<SimulationResponse, Error, void>({
    mutationFn: () =>
      fetch(`/api/products/${id}/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }).then((r) => r.json()),
    onSuccess: (data: SimulationResponse) => {
      const safe = data.recommendations.safe ?? data.recommendations.bestNetProfit;
      if (safe) setSelectedPrice(safe.salePrice);
    },
  });

  const saveCostMutation = useMutation({
    mutationFn: () => {
      const body = {
        cost: {
          costMode: "detailed",
          filamentTypeId: filamentTypeId || null,
          filamentWeight: fWeight,
          printTimeHours: pTime,
          wasteRate: wRate,
          packagingPoset: pPoset,
          packagingNaylon: pNaylon,
          packagingBant: pBant,
          packagingKart: pKart,
        },
      };

      return fetch(`/api/products/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["product", id] });
      toast.success("Maliyet bilgileri kaydedildi");
    },
    onError: () => toast.error("Kaydedilemedi"),
  });

  if (isLoading || !product) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">Yükleniyor...</p>
      </div>
    );
  }

  const simData = simulationMutation.data;
  const allValid = simData?.recommendations.allValid ?? [];
  const safe = simData?.recommendations.safe;
  const bestProfit = simData?.recommendations.bestNetProfit;
  const bestMargin = simData?.recommendations.bestMargin;

  const currentResult = allValid.find(
    (r) => r.salePrice === product.currentSalePrice
  );
  const selectedResult =
    selectedPrice !== null
      ? allValid.find((r) => r.salePrice === selectedPrice) ?? currentResult
      : currentResult;

  const chartData = allValid.map((r) => ({
    price: r.salePrice,
    profit: parseFloat(r.netProfit.toFixed(2)),
    margin: parseFloat((r.profitMargin * 100).toFixed(1)),
  }));

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/products" className={buttonVariants({ variant: "ghost", size: "icon" })}>
          <ArrowLeft className="h-4 w-4" />
        </Link>
        {product.imageUrl ? (
          <div className="w-16 h-16 rounded-lg border bg-white flex items-center justify-center flex-shrink-0 overflow-hidden">
            <img
              src={product.imageUrl}
              alt={product.name}
              className="max-w-full max-h-full object-contain"
            />
          </div>
        ) : (
          <div className="w-16 h-16 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
            <Package className="h-8 w-8 text-muted-foreground" />
          </div>
        )}
        <div>
          <h1 className="text-xl font-bold">{product.name}</h1>
          <p className="text-sm text-muted-foreground">
            {product.barcode} · {product.sku} · {product.categoryName}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column: Cost calculations */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Maliyet Hesaplama</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                  <div className="space-y-3">
                    <p className="text-xs font-semibold text-primary">3D BASKI PARAMETRELERİ</p>
                    <div>
                      <Label className="text-xs">Filament Türü</Label>
                      <select
                        value={filamentTypeId}
                        onChange={(e) => setFilamentTypeId(e.target.value)}
                        className="w-full h-9 rounded-md border bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <option value="">Seçin...</option>
                        {filaments.map((f: FilamentType) => (
                          <option key={f.id} value={f.id}>
                            {f.name} ({formatCurrency(f.costPerGram)}/g)
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label className="text-xs">Baskı Ağırlığı (g)</Label>
                        <Input
                          type="number"
                          value={filamentWeight}
                          onChange={(e) => setFilamentWeight(e.target.value)}
                          placeholder="0"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Süre (saat)</Label>
                        <Input
                          type="number"
                          step="0.1"
                          value={printTimeHours}
                          onChange={(e) => setPrintTimeHours(e.target.value)}
                          placeholder="0"
                        />
                      </div>
                    </div>
                    <div>
                      <Label className="text-xs">Fire Oranı (%)</Label>
                      <Input
                        type="number"
                        step="0.1"
                        value={wasteRate}
                        onChange={(e) => setWasteRate(e.target.value)}
                        placeholder="0"
                      />
                    </div>
                  </div>

                  <Separator />

                  <div className="space-y-3">
                    <p className="text-xs font-semibold text-primary">PAKETLEME GİDERLERİ</p>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label className="text-xs">Poşet/Koli (TL)</Label>
                        <Input
                          type="number"
                          step="0.01"
                          value={packagingPoset}
                          onChange={(e) => setPackagingPoset(e.target.value)}
                          placeholder="0.00"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Naylon (TL)</Label>
                        <Input
                          type="number"
                          step="0.01"
                          value={packagingNaylon}
                          onChange={(e) => setPackagingNaylon(e.target.value)}
                          placeholder="0.00"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label className="text-xs">Çift Taraf Bant (TL)</Label>
                        <Input
                          type="number"
                          step="0.01"
                          value={packagingBant}
                          onChange={(e) => setPackagingBant(e.target.value)}
                          placeholder="0.00"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Kart/Etiket/Süs (TL)</Label>
                        <Input
                          type="number"
                          step="0.01"
                          value={packagingKart}
                          onChange={(e) => setPackagingKart(e.target.value)}
                          placeholder="0.00"
                        />
                      </div>
                    </div>
                  </div>

                  <Separator />

                  <div className="space-y-1.5 text-xs text-muted-foreground p-2.5 bg-muted/30 rounded-md">
                    <div className="flex justify-between">
                      <span>Malzeme Maliyeti:</span>
                      <span className="font-mono">{formatCurrency(calcFilamentCost)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Elektrik ({electricityRate} TL/s):</span>
                      <span className="font-mono">{formatCurrency(calcElectricityCost)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Aşınma ({machineWearRate} TL/s):</span>
                      <span className="font-mono">{formatCurrency(calcMachineWearCost)}</span>
                    </div>
                    {calcLaborCost > 0 && (
                      <div className="flex justify-between">
                        <span>İşçilik ({laborRate} TL/s):</span>
                        <span className="font-mono">{formatCurrency(calcLaborCost)}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span>Paketleme Kalemleri:</span>
                      <span className="font-mono">{formatCurrency(calcPackagingTotal)}</span>
                    </div>
                    {calcWasteCost > 0 && (
                      <div className="flex justify-between text-amber-600">
                        <span>Fire Oranı ({wasteRate}%):</span>
                        <span className="font-mono">+{formatCurrency(calcWasteCost)}</span>
                      </div>
                    )}
                  </div>

              <Separator />

              <div className="flex justify-between items-center py-1">
                <span className="text-xs font-semibold text-foreground uppercase tracking-wider">TOPLAM MALİYET</span>
                <span className="text-lg font-bold text-foreground">
                  {formatCurrency(finalEffectiveTotalCost)}
                </span>
              </div>

              <Button
                size="sm"
                className="w-full"
                onClick={() => saveCostMutation.mutate()}
                disabled={saveCostMutation.isPending}
              >
                {saveCostMutation.isPending ? "Kaydediliyor..." : "Kaydet ve Uygula"}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">Ürün Satış Bilgisi</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Satış Fiyatı</span>
                <span className="font-semibold">{formatCurrency(product.currentSalePrice)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Stok</span>
                <span>{product.stock} adet</span>
              </div>
              {product.desi && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Desi</span>
                  <span>{product.desi} Desi</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Entegrasyon</span>
                <Badge variant="outline" className="text-xs uppercase tracking-wide">{product.source}</Badge>
              </div>
            </CardContent>
          </Card>

          <Button
            className="w-full"
            variant="outline"
            onClick={() => simulationMutation.mutate()}
            disabled={simulationMutation.isPending}
          >
            <Zap className="h-4 w-4 mr-2" />
            {simulationMutation.isPending ? "Hesaplanıyor..." : "Maliyet ile Simüle Et"}
          </Button>
        </div>

        {/* Right column: Simulation outcomes */}
        <div className="lg:col-span-2 space-y-4">
          {!simData && (
            <Card className="flex flex-col items-center justify-center py-20 text-center">
              <Zap className="h-10 w-10 text-muted-foreground/60 mb-3" />
              <p className="font-semibold text-foreground">Kâr Simülasyonu Hazır</p>
              <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                Maliyetleri girdikten sonra &quot;Maliyet ile Simüle Et&quot; butonuna basarak kârlılık grafiklerini ve Trendyol fiyat analizlerini anında görebilirsiniz.
              </p>
            </Card>
          )}

          {simData && (
            <>
              {/* Action recommendations */}
              <div className="grid grid-cols-3 gap-3">
                {safe && (
                  <Card
                    className="cursor-pointer border-2 border-primary bg-primary/5 transition-all hover:bg-primary/10"
                    onClick={() => setSelectedPrice(safe.salePrice)}
                  >
                    <CardHeader className="pb-1 p-3">
                      <CardTitle className="text-xs flex items-center gap-1 text-primary">
                        <Target className="h-3.5 w-3.5" /> Güvenli Öneri
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-3 pt-0 space-y-0.5">
                      <p className="text-lg font-bold">{formatCurrency(safe.salePrice)}</p>
                      <p className="text-xs text-green-600 font-medium">
                        {formatCurrency(safe.result.netProfit)} kâr
                      </p>
                      <p className="text-xs text-muted-foreground line-clamp-2 mt-1">{safe.reason}</p>
                    </CardContent>
                  </Card>
                )}
                {bestProfit && bestProfit.salePrice !== safe?.salePrice && (
                  <Card
                    className="cursor-pointer border hover:border-primary transition-all p-3"
                    onClick={() => setSelectedPrice(bestProfit.salePrice)}
                  >
                    <CardHeader className="pb-1 p-0">
                      <CardTitle className="text-xs flex items-center gap-1 text-muted-foreground">
                        <TrendingUp className="h-3.5 w-3.5 text-green-500" /> En Yüksek Kâr
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-0 pt-1 space-y-0.5">
                      <p className="text-lg font-bold">{formatCurrency(bestProfit.salePrice)}</p>
                      <p className="text-xs text-green-600 font-medium">
                        {formatCurrency(bestProfit.result.netProfit)} kâr
                      </p>
                    </CardContent>
                  </Card>
                )}
                {bestMargin && bestMargin.salePrice !== safe?.salePrice && (
                  <Card
                    className="cursor-pointer border hover:border-primary transition-all p-3"
                    onClick={() => setSelectedPrice(bestMargin.salePrice)}
                  >
                    <CardHeader className="pb-1 p-0">
                      <CardTitle className="text-xs flex items-center gap-1 text-muted-foreground">
                        <TrendingUp className="h-3.5 w-3.5 text-blue-500" /> En Yüksek Oran
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-0 pt-1 space-y-0.5">
                      <p className="text-lg font-bold">{formatCurrency(bestMargin.salePrice)}</p>
                      <p className="text-xs text-blue-600 font-medium">
                        {formatPercent(bestMargin.result.profitMargin)} kâr oranı
                      </p>
                    </CardContent>
                  </Card>
                )}
              </div>

              <Tabs defaultValue="charts">
                <TabsList>
                  <TabsTrigger value="charts">Grafikler</TabsTrigger>
                  <TabsTrigger value="breakdown">Kâr Dağılımı</TabsTrigger>
                  <TabsTrigger value="table">Tüm Fiyatlar</TabsTrigger>
                </TabsList>

                <TabsContent value="charts" className="space-y-4">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm">Fiyat vs Net Kâr</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ResponsiveContainer width="100%" height={220}>
                        <LineChart data={chartData}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                          <XAxis
                            dataKey="price"
                            tickFormatter={(v) => `${v} TL`}
                            tick={{ fontSize: 11 }}
                          />
                          <YAxis
                            tickFormatter={(v) => `${v} TL`}
                            tick={{ fontSize: 11 }}
                          />
                          <Tooltip
                            formatter={(v: number) => [formatCurrency(v), "Net Kâr"]}
                            labelFormatter={(l) => `Fiyat: ${formatCurrency(l)}`}
                          />
                          <ReferenceLine
                            x={product.currentSalePrice}
                            stroke="#94a3b8"
                            strokeDasharray="4 4"
                            label={{ value: "Mevcut", fontSize: 11 }}
                          />
                          {selectedPrice && selectedPrice !== product.currentSalePrice && (
                            <ReferenceLine
                              x={selectedPrice}
                              stroke="#3b82f6"
                              strokeDasharray="4 4"
                              label={{ value: "Seçili", fontSize: 11, fill: "#3b82f6" }}
                            />
                          )}
                          <Line
                            type="monotone"
                            dataKey="profit"
                            stroke="#22c55e"
                            dot={false}
                            strokeWidth={2}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm">Fiyat vs Kâr Oranı (%)</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ResponsiveContainer width="100%" height={160}>
                        <LineChart data={chartData}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                          <XAxis
                            dataKey="price"
                            tickFormatter={(v) => `${v} TL`}
                            tick={{ fontSize: 11 }}
                          />
                          <YAxis
                            tickFormatter={(v) => `%${v}`}
                            tick={{ fontSize: 11 }}
                          />
                          <Tooltip
                            formatter={(v: number) => [`%${v}`, "Kâr Oranı"]}
                            labelFormatter={(l) => `Fiyat: ${formatCurrency(l)}`}
                          />
                          <Line
                            type="monotone"
                            dataKey="margin"
                            stroke="#3b82f6"
                            dot={false}
                            strokeWidth={2}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="breakdown">
                  {selectedResult && (
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-sm">
                          Gider Dağılımı — {formatCurrency(selectedResult.salePrice)}
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <DeductionsPie result={selectedResult} />
                        <Separator className="my-3" />
                        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                          {[
                            ["Ürün Maliyeti", selectedResult.productCost],
                            ["Ambalaj Giderleri", selectedResult.packagingCost],
                            ["Trendyol Komisyon", selectedResult.commissionCost],
                            ["Kargo Gideri", selectedResult.cargoCost],
                            ["Sabit Giderler", selectedResult.fixedExpenses],
                            ["Değişken Giderler", selectedResult.variableExpenses],
                          ].map(([label, value]) => (
                            <div key={String(label)} className="flex justify-between">
                              <span className="text-muted-foreground">{label}</span>
                              <span>{formatCurrency(Number(value))}</span>
                            </div>
                          ))}
                          <div className="flex justify-between col-span-2 border-t pt-1 mt-1 font-medium">
                            <span>Net Kâr</span>
                            <span className={selectedResult.netProfit < 0 ? "text-destructive" : "text-green-600"}>
                              {formatCurrency(selectedResult.netProfit)}
                            </span>
                          </div>
                          <div className="flex justify-between col-span-2">
                            <span className="text-muted-foreground">Kâr Oranı</span>
                            <span>{formatPercent(selectedResult.profitMargin)}</span>
                          </div>
                        </div>
                        {selectedResult.appliedCommissionRule && (
                          <div className="mt-3 p-2 bg-muted rounded text-xs text-muted-foreground">
                            <span className="font-medium">Komisyon Kuralı: </span>
                            {selectedResult.appliedCommissionRule.name} ·{" "}
                            %{(selectedResult.appliedCommissionRule.commissionRate * 100).toFixed(0)}
                          </div>
                        )}
                        {selectedResult.appliedCargoRule && (
                          <div className="mt-1 p-2 bg-muted rounded text-xs text-muted-foreground">
                            <span className="font-medium">Kargo Kuralı: </span>
                            {selectedResult.appliedCargoRule.name} ·{" "}
                            {formatCurrency(selectedResult.appliedCargoRule.cargoCost)}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )}
                </TabsContent>

                <TabsContent value="table">
                  <Card>
                    <CardContent className="p-0">
                      <div className="overflow-auto max-h-96">
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-muted">
                            <tr>
                              <th className="text-left p-2 font-medium">Fiyat</th>
                              <th className="text-right p-2 font-medium">Komisyon</th>
                              <th className="text-right p-2 font-medium">Kargo</th>
                              <th className="text-right p-2 font-medium">Net Kâr</th>
                              <th className="text-right p-2 font-medium">Kâr %</th>
                              <th className="text-center p-2 font-medium">Geçerli</th>
                            </tr>
                          </thead>
                          <tbody>
                            {allValid.map((r) => (
                              <tr
                                key={r.salePrice}
                                className={`border-b cursor-pointer hover:bg-muted/50 ${selectedPrice === r.salePrice ? "bg-primary/10" : ""}`}
                                onClick={() => setSelectedPrice(r.salePrice)}
                              >
                                <td className="p-2 font-medium">
                                  {formatCurrency(r.salePrice)}
                                  {r.salePrice === product.currentSalePrice && (
                                    <Badge variant="outline" className="ml-1 text-xs">Mevcut</Badge>
                                  )}
                                </td>
                                <td className="p-2 text-right">{formatCurrency(r.commissionCost)}</td>
                                <td className="p-2 text-right">{formatCurrency(r.cargoCost)}</td>
                                <td className={`p-2 text-right font-medium ${r.netProfit < 0 ? "text-destructive" : "text-green-600"}`}>
                                  {formatCurrency(r.netProfit)}
                                </td>
                                <td className="p-2 text-right">{formatPercent(r.profitMargin)}</td>
                                <td className="p-2 text-center">
                                  {r.isValid ? "✓" : "✗"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </Card>
                </TabsContent>
              </Tabs>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
