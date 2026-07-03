import 'package:flutter_test/flutter_test.dart';
import 'package:dynops_mobile/features/meetings/meetings_screen.dart';

void main() {
  test('parses meeting approval json', () {
    final m = Meeting.fromJson({
      'id': 'a1',
      'action': 'create_calendar_event',
      'meeting': {'title': 'Demo', 'start': '2026-06-15T09:00:00Z', 'end': '2026-06-15T10:00:00Z', 'attendees': ['x@y.com'], 'location': 'Teams'},
    });
    expect(m.title, 'Demo');
    expect(m.start!.toUtc().hour, 9);
    expect(m.attendees, ['x@y.com']);
  });
}
