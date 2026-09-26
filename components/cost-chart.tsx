"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { estMoney } from "@/components/format";

export type CostPoint = {
  name: string;
  patient: string;
  drug: string;
  current: number | null;
  alternative: number | null;
  alternativeName: string | null;
};

const CURRENT = "#dc2626";
const ALTERNATIVE = "#16a34a";

function CostTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: CostPoint }>;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="max-w-56 rounded-lg bg-white px-3 py-2 text-sm shadow-md ring-1 ring-neutral-200">
      <p className="font-medium text-neutral-950">{point.patient}</p>
      <p className="mt-1 text-neutral-700">
        {point.drug}: {estMoney(point.current)}/mo
      </p>
      <p className="mt-1 text-emerald-800">
        {point.alternativeName
          ? `${point.alternativeName}: ${estMoney(point.alternative)}/mo`
          : "No safe cheaper option"}
      </p>
    </div>
  );
}

export function CostChart({ points }: { points: CostPoint[] }) {
  const height = Math.max(280, points.length * 72 + 56);

  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 360, height }}>
        <BarChart
          data={points}
          layout="vertical"
          margin={{ top: 8, right: 8, left: 0, bottom: 8 }}
          barCategoryGap={14}
          barGap={3}
        >
          <CartesianGrid stroke="#e5e5e5" horizontal={false} />
          <XAxis
            type="number"
            tickFormatter={(value: number) => `est. $${Math.round(value)}`}
            tick={{ fontSize: 11, fill: "#525252" }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={84}
            tick={{ fontSize: 13, fill: "#171717" }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip content={(props) => <CostTooltip active={props.active} payload={props.payload} />} />
          <Legend
            wrapperStyle={{ fontSize: 13, paddingTop: 8 }}
            formatter={(value) => <span className="text-neutral-700">{value}</span>}
          />
          <Bar
            dataKey="current"
            name="Current cost"
            fill={CURRENT}
            radius={[0, 4, 4, 0]}
            maxBarSize={18}
          />
          <Bar
            dataKey="alternative"
            name="Alternative cost"
            fill={ALTERNATIVE}
            radius={[0, 4, 4, 0]}
            maxBarSize={18}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
