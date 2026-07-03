import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import '../../core/session.dart';
import '../approvals/approvals_models.dart';

class Meeting {
  Meeting({required this.id, this.title, this.start, this.end, this.attendees = const [], this.location});
  final String id;
  final String? title;
  final DateTime? start;
  final DateTime? end;
  final List<String> attendees;
  final String? location;

  factory Meeting.fromJson(Map<String, dynamic> j) {
    final m = (j['meeting'] as Map?)?.cast<String, dynamic>() ?? const {};
    return Meeting(
      id: j['id'] as String,
      title: (m['title'] ?? j['reason'] ?? 'Toplantı') as String?,
      start: m['start'] != null ? DateTime.tryParse(m['start'] as String) : null,
      end: m['end'] != null ? DateTime.tryParse(m['end'] as String) : null,
      attendees: (m['attendees'] as List? ?? const []).map((e) => e.toString()).toList(),
      location: m['location'] as String?,
    );
  }
}

final meetingsProvider = FutureProvider.autoDispose<List<Meeting>>((ref) async {
  final api = ref.watch(sessionProvider)!.api;
  return unwrapList(await api.get('/meetings')).map(Meeting.fromJson).toList();
});

class MeetingsScreen extends ConsumerWidget {
  const MeetingsScreen({super.key});

  Future<void> _act(WidgetRef ref, String id, String action, {Map<String, dynamic>? body}) async {
    await ref.read(sessionProvider)!.api.post('/meetings/$id/$action', body: body);
    ref.invalidate(meetingsProvider);
  }

  Future<void> _proposeTime(BuildContext context, WidgetRef ref, Meeting m) async {
    final date = await showDatePicker(
      context: context,
      initialDate: m.start ?? DateTime.now(),
      firstDate: DateTime.now(),
      lastDate: DateTime.now().add(const Duration(days: 90)),
    );
    if (date == null || !context.mounted) return;
    final time = await showTimePicker(context: context, initialTime: const TimeOfDay(hour: 10, minute: 0));
    if (time == null) return;
    final newTime = DateTime(date.year, date.month, date.day, time.hour, time.minute).toUtc().toIso8601String();
    await _act(ref, m.id, 'propose-time', body: {'newTime': newTime});
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(meetingsProvider);
    final canDecide = ref.watch(sessionProvider)?.canDecide ?? false;
    final fmt = DateFormat('d MMM HH:mm');
    return Scaffold(
      appBar: AppBar(title: const Text('Toplantılar')),
      body: list.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Hata: $e')),
        data: (items) => items.isEmpty
            ? const Center(child: Text('Bekleyen toplantı onayı yok'))
            : ListView.builder(
                itemCount: items.length,
                itemBuilder: (_, i) {
                  final m = items[i];
                  return Card(
                    margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(m.title ?? 'Toplantı', style: Theme.of(context).textTheme.titleMedium),
                        const SizedBox(height: 4),
                        Text([
                          if (m.start != null) fmt.format(m.start!),
                          if (m.location != null) m.location!,
                          if (m.attendees.isNotEmpty) m.attendees.join(', '),
                        ].join(' · ')),
                        if (canDecide)
                          Row(mainAxisAlignment: MainAxisAlignment.end, children: [
                            TextButton(onPressed: () => _act(ref, m.id, 'reject', body: {'note': 'Mobilden reddedildi'}), child: const Text('Reddet')),
                            TextButton(onPressed: () => _proposeTime(context, ref, m), child: const Text('Alternatif zaman')),
                            FilledButton(onPressed: () => _act(ref, m.id, 'accept'), child: const Text('Kabul')),
                          ]),
                      ]),
                    ),
                  );
                },
              ),
      ),
    );
  }
}
