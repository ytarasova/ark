import { Card, CardContent, CardHeader } from "../ui/card.js";

export function MetricsSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
      {[0, 1, 2, 3].map((i) => (
        <Card key={i}>
          <CardHeader className="pb-1 pt-3 px-3">
            <div className="h-3 w-12 rounded skeleton-shimmer" />
          </CardHeader>
          <CardContent className="px-3 pb-3">
            <div className="h-7 w-16 rounded skeleton-shimmer mb-2" />
            <div className="h-[60px] w-full rounded skeleton-shimmer" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
