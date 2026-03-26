const https = require('https');

function parseUTM(url, param) {
  try {
    if (!url) return null;
    const match = url.match(new RegExp('[?&]' + param + '=([^&]+)'));
    return match ? decodeURIComponent(match[1]) : null;
  } catch { return null; }
}

function parseSource(url) {
  if (!url) return null;
  // Check for sl= param (SC funnel source)
  const sl = parseUTM(url, 'sl');
  if (sl) {
    const map = { fb: 'Facebook', ig: 'Instagram', tt: 'TikTok', gg: 'Google', yt: 'YouTube', em: 'Email', org: 'Organic' };
    return map[sl] || sl;
  }
  // Check for utm_source
  const utm = parseUTM(url, 'utm_source');
  if (utm) return utm;
  // Check for fbclid (Facebook/Instagram)
  if (url.includes('fbclid')) return 'Meta';
  // Check for gclid (Google)
  if (url.includes('gclid')) return 'Google';
  // Check for ttclid (TikTok)
  if (url.includes('ttclid')) return 'TikTok';
  return null;
}

function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const reqOpts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    };
    const req = https.request(reqOpts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'max-age=30',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const CLOSE_KEY = process.env.CLOSE_API_KEY;
  const SLACK_TOKEN = process.env.SLACK_USER_TOKEN;

  const params = event.queryStringParameters || {};
  const dateFrom = params.from || new Date(Date.now() - 7*86400000).toISOString().slice(0,10);
  const dateTo = params.to || new Date().toISOString().slice(0,10);
  const dateGte = dateFrom + 'T00:00:00Z';
  const dateLte = dateTo + 'T23:59:59Z';

  try {
    const closeAuth = Buffer.from(CLOSE_KEY + ':').toString('base64');

    // PAGINATED: Get ALL opportunities in date range (booked calls)
    let allOpps = [];
    let oppOffset = 0;
    while (true) {
      const oppsPage = await fetch(
        'https://api.close.com/api/v1/opportunity/?_limit=100&_skip=' + oppOffset + '&_order_by=-date_created&date_created__gte=' + encodeURIComponent(dateGte) + '&date_created__lte=' + encodeURIComponent(dateLte) + '&_fields=lead_name,lead_id,status_label,value,pipeline_name,user_name,date_created',
        { headers: { 'Authorization': 'Basic ' + closeAuth } }
      );
      const data = oppsPage.data || [];
      allOpps = allOpps.concat(data);
      if (data.length < 100 || allOpps.length >= 500) break;
      oppOffset += 100;
    }

    // PAGINATED: Get calls for duration/recording data
    let allCalls = [];
    let callOffset = 0;
    while (true) {
      const callsPage = await fetch(
        'https://api.close.com/api/v1/activity/call/?_limit=100&_skip=' + callOffset + '&_order_by=-date_created&date_created__gte=' + encodeURIComponent(dateGte) + '&date_created__lte=' + encodeURIComponent(dateLte) + '&_fields=date_created,user_name,duration,disposition,note,lead_id,direction,recording_url',
        { headers: { 'Authorization': 'Basic ' + closeAuth } }
      );
      const data = callsPage.data || [];
      allCalls = allCalls.concat(data);
      if (data.length < 100 || allCalls.length >= 500) break;
      callOffset += 100;
    }

    // Build call duration map by lead_id (longest call per lead)
    const callMap = {};
    for (const call of allCalls) {
      if (!call.lead_id) continue;
      if (!callMap[call.lead_id] || call.duration > callMap[call.lead_id].duration) {
        callMap[call.lead_id] = call;
      }
    }

    // Slack payments
    const slackPayments = await fetch(
      'https://slack.com/api/conversations.history?channel=C077FCDLETG&limit=100',
      { headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN } }
    );
    const slackDeals = await fetch(
      'https://slack.com/api/conversations.history?channel=C078AQ0P000&limit=100',
      { headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN } }
    );

    // Parse payments
    const payments = [];
    if (slackPayments.messages) {
      for (const msg of slackPayments.messages) {
        if (!msg.bot_id || !msg.text) continue;
        const msgDate = new Date(parseFloat(msg.ts) * 1000);
        if (msgDate < new Date(dateGte) || msgDate > new Date(dateLte)) continue;
        const text = msg.text;
        let name = '', email = '', amount = 0, method = '';
        if (text.includes('PAID via Elective')) {
          name = (text.match(/Customer name:\s*(.+)/i) || [])[1] || '';
          email = (text.match(/Email:\s*<mailto:([^|]+)/i) || [])[1] || '';
          amount = parseInt((text.match(/Amount paid:\s*(\d+)/i) || [])[1] || '0');
          method = 'Elective';
        } else if (text.includes('FanBasis Payments')) {
          name = (text.match(/Client Name:\s*(.+)/i) || [])[1] || '';
          email = (text.match(/Client Email:\s*<mailto:([^|]+)/i) || [])[1] || '';
          amount = parseInt((text.match(/Amount:\s*(\d+)/i) || [])[1] || '0') / 100;
          method = (text.match(/Payment Method:\s*(.+)/i) || [])[1] || 'FanBasis';
        } else if (text.includes('new deal has just been closed')) {
          name = (text.match(/Client name:\s*(.+)/i) || [])[1] || '';
          email = (text.match(/Client email:\s*<mailto:([^|]+)/i) || [])[1] || '';
          const amtMatch = text.match(/Amount paid:\s*\$?\s*([\d,.]+)/i);
          amount = amtMatch ? parseFloat(amtMatch[1].replace(',', '')) : 0;
          method = (text.match(/Payment option:\s*(.+)/i) || [])[1] || '';
        }
        if (name && amount > 0) {
          payments.push({ name: name.trim(), email: email.trim(), amount, method: method.trim(), ts: msg.ts, date: msgDate.toISOString() });
        }
      }
    }

    // Parse deals
    const deals = [];
    if (slackDeals.messages) {
      for (const msg of slackDeals.messages) {
        if (!msg.bot_id || !msg.text || !msg.text.includes('new deal')) continue;
        const msgDate = new Date(parseFloat(msg.ts) * 1000);
        if (msgDate < new Date(dateGte) || msgDate > new Date(dateLte)) continue;
        const text = msg.text;
        deals.push({
          rep: ((text.match(/Sold by:\s*(.+)/i) || [])[1] || '').trim(),
          name: ((text.match(/Client name:\s*(.+)/i) || [])[1] || '').trim(),
          email: ((text.match(/Client email:\s*<mailto:([^|]+)/i) || [])[1] || '').trim(),
          phone: ((text.match(/Client phone:\s*(?:<tel:[^|]+\|)?([^>]+)/i) || [])[1] || '').trim(),
          program: ((text.match(/Program purchased:\s*(.+)/i) || [])[1] || '').trim(),
          ts: msg.ts, date: msgDate.toISOString()
        });
      }
    }

    // Enrich opportunities with lead data (batch — max 50 unique leads)
    const enriched = [];
    const seenLeads = {};
    const leadCache = {};

    for (const opp of allOpps) {
      // Deduplicate by lead name
      const leadKey = (opp.lead_name || '').toLowerCase().trim();
      if (seenLeads[leadKey]) continue;
      seenLeads[leadKey] = true;

      let leadData = null;
      if (opp.lead_id) {
        if (leadCache[opp.lead_id]) {
          leadData = leadCache[opp.lead_id];
        } else if (Object.keys(leadCache).length < 60) {
          try {
            leadData = await fetch(
              'https://api.close.com/api/v1/lead/' + opp.lead_id + '/?_fields=display_name,status_label,custom',
              { headers: { 'Authorization': 'Basic ' + closeAuth } }
            );
            leadCache[opp.lead_id] = leadData;
          } catch {}
        }
      }

      const call = callMap[opp.lead_id] || null;
      const custom = leadData && leadData.custom || {};
      const calUrl = custom['Pre-filled Calendly'] || '';

      enriched.push({
        name: opp.lead_name,
        status: opp.status_label,
        pipeline: opp.pipeline_name,
        rep: opp.user_name,
        date: opp.date_created,
        value: opp.value,
        // Call data
        callDuration: call ? call.duration : null,
        callDate: call ? call.date_created : null,
        hasRecording: call ? !!call.recording_url : false,
        callNote: call ? (call.note || '').substring(0, 200) : '',
        // LeadFi data
        cs: custom['Credit Score'] || null,
        income: custom['Income Estimate'] || null,
        availableCredit: custom['Available Credit'] || null,
        dti: custom['DTI'] || null,
        creditFrozen: custom['Credit Frozen?'] || null,
        age: custom['Age'] || null,
        leadScore: custom['Lead Score'] || null,
        city: custom['Prospect City'] || null,
        state: custom['Prospect State'] || null,
        setter: custom['appointment_user_fullname'] || null,
        appointmentTime: custom['appointment_start_time'] || null,
        // Source
        source: parseSource(calUrl),
        campaign: parseUTM(calUrl, 'utm_campaign'),
        typeform: custom['Typeform'] || null,
      });
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        dateRange: { from: dateFrom, to: dateTo },
        leads: enriched,
        calls: allCalls,
        opportunities: allOpps,
        payments, deals,
        stats: {
          totalLeads: enriched.length,
          totalCalls: allCalls.length,
          totalOpps: allOpps.length,
          totalPayments: payments.length,
          totalDeals: deals.length,
          cashTotal: payments.reduce((s, p) => s + p.amount, 0),
        }
      })
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
