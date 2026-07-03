import 'package:flutter_test/flutter_test.dart';
import 'package:dynops_mobile/features/approvals/approvals_models.dart';

void main() {
  test('parses approval json defensively', () {
    final a = Approval.fromJson({
      'id': 'x',
      'action': 'send_email',
      'status': 'pending',
      'risk_level': 'medium',
      'reason': 'Mission çözümü',
      'payload': {'body': 'Merhaba', 'to': ['a@b.com']},
      'created_at': '2026-06-14T10:00:00Z',
      'activity': {'subject': 'Re: Fatura', 'channel': 'email'},
    });
    expect(a.action, 'send_email');
    expect(a.subject, 'Re: Fatura');
    expect(a.draftText, 'Merhaba');
    expect(a.riskLevel, 'medium');
  });

  test('unwraps {items:[…]} envelopes', () {
    expect(unwrapList([{'id': '1'}]).length, 1);
    expect(unwrapList({'items': [{'id': '1'}, {'id': '2'}]}).length, 2);
    expect(unwrapList({'data': [{'id': '1'}, {'id': '2'}, {'id': '3'}]}).length, 3);
  });
}
