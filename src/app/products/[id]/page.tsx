"use client";

import { use, useState } from "react";
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
import { ArrowLeft, Zap, TrendingUp, Target } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import Link from "next/link";
import { toast } from "sonner";
import type { RecommendationOutput, SimulationResult } from "@/core/types";

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
  source: string;
  cost: {
    costMode: string;
    manualCost: number | null;
    packagingCost: number | null;
    materialWeight: number | null;
    printTimeHours: number | null;
    totalCost: number | null;
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
  const [productCost, setProductCost] = useState("");
  const [packagingCost, setPackagingCost] = useState("");
  const [selectedPrice, setSelectedPrice] = useState<number | null>(null);

  const { data: product, isLoading } = useQuery<ProductDetail>({
    queryKey: ["product", id],
    queryFn: () => fetch(`/api/products/${id}`).then((r) => r.json()),
  });

  const effectiveProductCost =
    productCost || (product?.cost?.manualCost ? String(product.cost.manualCost) : "");
  const effectivePackagingCost =
    packagingCost || (product?.cost?.packagingCost ? String(product.cost.packagingCost) : "");

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
    mutationFn: () =>
      fetch(`/api/products/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cost: {
        manualCost: parseFloat(effectiveProductCost) || 0,
        packagingCost: parseFloat(effectivePackagingCost) || 0,
            totalCost:
          (parseFloat(effectiveProductCost) || 0) + (parseFloat(effectivePackagingCost) || 0),
          },
        }),
      }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["product", id] });
      toast.success("Maliyet kaydedildi");
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
      <div className="flex items-center gap-3">
        <Link href="/products" className={buttonVariants({ variant: "ghost", size: "icon" })}>
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-xl font-bold">{product.name}</h1>
          <p className="text-sm text-muted-foreground">
            {product.barcode} · {product.sku} · {product.categoryName}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Cost + Simulate */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Maliyet Bilgisi</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label className="text-xs">Ürün Maliyeti (TL)</Label>
                <Input
                  type="number"
                  step="0.01"
                    value={effectiveProductCost}
                  onChange={(e) => setProductCost(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div>
                <Label className="text-xs">Ambalaj Maliyeti (TL)</Label>
                <Input
                  type="number"
                  step="0.01"
                    value={effectivePackagingCost}
                  onChange={(e) => setPackagingCost(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="pt-1 border-t">
                <p className="text-xs text-muted-foreground">Toplam Maliyet</p>
                <p className="font-semibold">
                  {formatCurrency(
                  (parseFloat(effectiveProductCost) || 0) +
                  (parseFloat(effectivePackagingCost) || 0)
                  )}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={() => saveCostMutation.mutate()}
                disabled={saveCostMutation.isPending}
              >
                {saveCostMutation.isPending ? "Kaydediliyor..." : "Kaydet"}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Ürün Bilgisi</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Satış Fiyatı</span>
                <span className="font-medium">{formatCurrency(product.currentSalePrice)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Stok</span>
                <span>{product.stock}</span>
              </div>
              {product.desi && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Desi</span>
                  <span>{product.desi}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Kaynak</span>
                <Badge variant="outline" className="text-xs">{product.source}</Badge>
              </div>
            </CardContent>
          </Card>

          <Button
            className="w-full"
            onClick={() => simulationMutation.mutate()}
            disabled={simulationMutation.isPending}
          >
            <Zap className="h-4 w-4 mr-2" />
            {simulationMutation.isPending ? "Hesaplanıyor..." : "Simülasyon Çalıştır"}
          </Button>
        </div>

        {/* Right: Results */}
        <div className="lg:col-span-2 space-y-4">
          {!simData && (
            <Card className="flex flex-col items-center justify-center py-16 text-center">
              <Zap className="h-10 w-10 text-muted-foreground mb-3" />
              <p className="font-medium">Simülasyon Hazır</p>
              <p className="text-sm text-muted-foreground mt-1">
                Maliyeti girin ve &quot;Simülasyon Çalıştır&quot; butonuna basın.
              </p>
            </Card>
          )}

          {simData && (
            <>
              {/* Recommendations */}
              <div className="grid grid-cols-3 gap-3">
                {safe && (
                  <Card
                    className="cursor-pointer border-2 border-primary"
                    onClick={() => setSelectedPrice(safe.salePrice)}
                  >
                    <CardHeader className="pb-1">
                      <CardTitle className="text-xs flex items-center gap-1 text-primary">
                        <Target className="h-3 w-3" /> Güvenli Öneri
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-0.5">
                      <p className="text-lg font-bold">{formatCurrency(safe.salePrice)}</p>
                      <p className="text-xs text-green-600">{formatCurrency(safe.result.netProfit)} kâr</p>
                      <p className="text-xs text-muted-foreground line-clamp-2">{safe.reason}</p>
                    </CardContent>
                  </Card>
                )}
                {bestProfit && bestProfit.salePrice !== safe?.salePrice && (
                  <Card
                    className="cursor-pointer hover:border-primary"
                    onClick={() => setSelectedPrice(bestProfit.salePrice)}
                  >
                    <CardHeader className="pb-1">
                      <CardTitle className="text-xs flex items-center gap-1">
                        <TrendingUp className="h-3 w-3" /> En Yüksek Kâr
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-0.5">
                      <p className="text-lg font-bold">{formatCurrency(bestProfit.salePrice)}</p>
                      <p className="text-xs text-green-600">{formatCurrency(bestProfit.result.netProfit)} kâr</p>
                    </CardContent>
                  </Card>
                )}
                {bestMargin && bestMargin.salePrice !== safe?.salePrice && (
                  <Card
                    className="cursor-pointer hover:border-primary"
                    onClick={() => setSelectedPrice(bestMargin.salePrice)}
                  >
                    <CardHeader className="pb-1">
                      <CardTitle className="text-xs flex items-center gap-1">
                        <TrendingUp className="h-3 w-3" /> En Yüksek Oran
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-0.5">
                      <p className="text-lg font-bold">{formatCurrency(bestMargin.salePrice)}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatPercent(bestMargin.result.profitMargin)}
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
                            ["Ambalaj", selectedResult.packagingCost],
                            ["Komisyon", selectedResult.commissionCost],
                            ["Kargo", selectedResult.cargoCost],
                            ["Sabit Gider", selectedResult.fixedExpenses],
                            ["Değişken Gider", selectedResult.variableExpenses],
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
