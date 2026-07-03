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
      start: m['start'] != null ? DateTime.tryParse(m['start'] as String)?.toLocal() : null,
      end: m['end'] != null ? DateTime.tryParse(m['end'] as String)?.toLocal() : null,
      attendees: (m['attendees'] as List? ?? const []).map((e) => e.toString()).toList(),
      location: m['location'] as String?,
    );
  }
}

final meetingsProvider = FutureProvider.autoDispose<List<Meeting>>((ref) async {
  final api = ref.watch(sessionProvider)!.api;
  return unwrapList(await api.get('/meetings')).map(Meeting.fromJson).toList();
});

class MeetingsScreen extends ConsumerStatefulWidget {
  const MeetingsScreen({super.key});
  @override
  ConsumerState<MeetingsScreen> createState() => _MeetingsScreenState();
}

class _MeetingsScreenState extends ConsumerState<MeetingsScreen> {
  final _busyIds = <String>{};

  Future<void> _act(String id, String action, {Map<String, dynamic>? body}) async {
    setState(() => _busyIds.add(id));
    try {
      await ref.read(sessionProvider)!.api.post('/meetings/$id/$action', body: body);
      ref.invalidate(meetingsProvider);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('İşlem başarısız: $e')));
      }
    } finally {
      if (mounted) setState(() => _busyIds.remove(id));
    }
  }

  Future<void> _proposeTime(Meeting m) async {
    final date = await showDatePicker(
      context: context,
      initialDate: m.start ?? DateTime.now(),
      firstDate: DateTime.now(),
      lastDate: DateTime.now().add(const Duration(days: 90)),
    );
    if (date == null || !mounted) return;
    final time = await showTimePicker(context: context, initialTime: const TimeOfDay(hour: 10, minute: 0));
    if (time == null || !mounted) return;
    final newTime = DateTime(date.year, date.month, date.day, time.hour, time.minute).toUtc().toIso8601String();
    await _act(m.id, 'propose-time', body: {'newTime': newTime});
  }

  @override
  Widget build(BuildContext context) {
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
                  final busy = _busyIds.contains(m.id);
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
                            TextButton(onPressed: busy ? null : () => _act(m.id, 'reject', body: {'note': 'Mobilden reddedildi'}), child: const Text('Reddet')),
                            TextButton(onPressed: busy ? null : () => _proposeTime(m), child: const Text('Alternatif zaman')),
                            FilledButton(onPressed: busy ? null : () => _act(m.id, 'accept'), child: const Text('Kabul')),
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
