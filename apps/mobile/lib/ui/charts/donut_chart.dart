import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';

import '../components/theme_tokens.dart';
import '../tokens/tokens.dart';

class DonutChart extends StatelessWidget {
  const DonutChart({super.key, required this.data, required this.centerLabel});

  final List<({String name, double value, Color color})> data;
  final String centerLabel;

  @override
  Widget build(BuildContext context) {
    final c = dynColorsFor(context);
    final total = data.fold<double>(0, (sum, d) => sum + d.value);
    return Row(children: [
      SizedBox(
        width: 132,
        height: 132,
        child: Stack(alignment: Alignment.center, children: [
          PieChart(
            PieChartData(
              sectionsSpace: 2,
              centerSpaceRadius: 42,
              sections: [
                for (final d in data)
                  PieChartSectionData(
                    color: d.color,
                    value: d.value,
                    radius: 20,
                    showTitle: false,
                  ),
              ],
            ),
          ),
          Text(centerLabel, style: DynType.kpi(c).copyWith(fontSize: 22)),
        ]),
      ),
      const SizedBox(width: 16),
      Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          for (final d in data)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(children: [
                Container(width: 10, height: 10, decoration: BoxDecoration(color: d.color, borderRadius: DynRadii.smRadius)),
                const SizedBox(width: 8),
                Expanded(child: Text(d.name, style: DynType.body(c).copyWith(fontSize: 12))),
                Text(_value(d.value, total), style: DynType.mono(c).copyWith(fontSize: 12, color: c.mutedFg)),
              ]),
            ),
        ]),
      ),
    ]);
  }

  String _value(double value, double total) {
    if (total <= 0) return '0';
    final pct = value / total * 100;
    return '${pct.round()}%';
  }
}
