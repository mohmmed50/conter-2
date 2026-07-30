import os
import threading
import time
import datetime
import logging
import concurrent.futures
import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, send_from_directory
import urllib3

# Load credentials from a local .env file (not committed to git; see .env.example)
load_dotenv()

# Suppress insecure SSL connection warnings since target site may have cert issues
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

app = Flask(__name__, template_folder='templates', static_folder='static')

# Set up logging configuration
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# Thread-safe global cache for the scraped statistics
cache_lock = threading.Lock()
stats_cache = {
    "data": [],
    "last_updated": None,
    "status": "loading",  # "loading", "success", "stale", "error"
    "error_message": None
}

# Target system credentials and endpoints
LOGIN_URL = "https://studentact.scu.eg/system/logins.php"
STATS_URL = "https://studentact.scu.eg/system/univ/takrerstat.php"
UNIV_ACTIVITIES_URL = "https://studentact.scu.eg/system/univ/addActivity.php?id=1"
ACTIVITIES_AJAX_URL = "https://studentact.scu.eg/system/univ/activities_ajax.php"
VIEW_ACTIVITY_URL = "https://studentact.scu.eg/system/univ/viewActivity.php"
USERNAME = os.environ.get("SCU_USERNAME")
PASSWORD = os.environ.get("SCU_PASSWORD")

if not USERNAME or not PASSWORD:
    logger.warning(
        "SCU_USERNAME / SCU_PASSWORD are not set. Create a .env file (see .env.example) "
        "with your studentact.scu.eg credentials, or the login will fail."
    )

REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": UNIV_ACTIVITIES_URL,
}

# Maintain session cookies across requests
session = requests.Session()
is_authenticated = False

def _snippet(text, n=200):
    """Returns a short, single-line preview of a response body for diagnostics."""
    flat = " ".join((text or "").split())
    return flat[:n]


def do_login(sess):
    """Performs the POST login request to authenticate the session."""
    global is_authenticated

    if not USERNAME or not PASSWORD:
        is_authenticated = False
        raise Exception(
            "Missing credentials: SCU_USERNAME / SCU_PASSWORD environment variables "
            "are not set on this deployment."
        )

    logger.info("Attempting login to university system...")
    payload = {
        "username": USERNAME,
        "password": PASSWORD
    }
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": LOGIN_URL
    }

    # We send the login payload. The form fields are 'username' and 'password' (no CSRF found).
    r = sess.post(LOGIN_URL, data=payload, headers=headers, verify=False, timeout=15)
    logger.info(f"Login POST -> status={r.status_code}, final_url={r.url}, body_len={len(r.text)}")

    if r.status_code != 200:
        is_authenticated = False
        raise Exception(f"Login failed: HTTP status code {r.status_code} (body: {_snippet(r.text)})")

    # Check if login was rejected by reading the HTML content
    if "اسم المستخدم" in r.text and "كلمة المرور" in r.text and ("خطأ" in r.text or "Error" in r.text or "عفواً" in r.text):
        is_authenticated = False
        raise Exception(f"Login failed: Invalid credentials or account blocked (body: {_snippet(r.text)})")

    # Sanity check: a successful login should leave us off the login page with some cookies set
    if not sess.cookies:
        logger.warning("Login response looked OK but no cookies were set on the session.")

    is_authenticated = True
    logger.info(f"Login successful. Session cookies: {list(sess.cookies.keys())}")
    return True

def ensure_authenticated():
    """Logs in only if the current session isn't already authenticated."""
    if not is_authenticated:
        do_login(session)

def scrape_and_update():
    """Fetches the stats page, parses the HTML table, and updates the in-memory cache."""
    global stats_cache, is_authenticated

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": LOGIN_URL
    }

    try:
        # 1. Login if not authenticated
        if not is_authenticated:
            do_login(session)

        # 2. Fetch the statistics page
        logger.info("Fetching university statistics page...")
        r = session.get(STATS_URL, headers=headers, verify=False, timeout=15)
        logger.info(f"Stats GET -> status={r.status_code}, final_url={r.url}, body_len={len(r.text)}")

        # 3. Handle possible session expiry (redirect or login form elements returned)
        soup = BeautifulSoup(r.text, 'html.parser')
        table = soup.find('table')

        if not table or "username" in r.text or "logins.php" in r.url:
            logger.warning("Session expired or invalid. Attempting re-authentication...")
            is_authenticated = False
            do_login(session)
            # Re-fetch stats page
            logger.info("Re-fetching statistics page after login...")
            r = session.get(STATS_URL, headers=headers, verify=False, timeout=15)
            logger.info(f"Stats GET (retry) -> status={r.status_code}, final_url={r.url}, body_len={len(r.text)}")
            soup = BeautifulSoup(r.text, 'html.parser')
            table = soup.find('table')

        if not table:
            raise Exception(
                f"HTML table element not found on statistics page "
                f"(status={r.status_code}, url={r.url}, body: {_snippet(r.text)})"
            )

        # 4. Parse the table rows
        rows = table.find_all('tr')
        parsed_data = []

        # Structure matches:
        # <tr>
        #     <td>13</td> (Rank)
        #     <td class="text-right">الزقازيق الاهليه</td> (University Name)
        #     <td>4227</td> (Number of Activities)
        # </tr>
        for row in rows:
            tds = row.find_all('td')
            if len(tds) >= 3:
                rank = tds[0].get_text(strip=True)
                name = tds[1].get_text(strip=True)
                activities = tds[2].get_text(strip=True)

                # Filter out rows that are not data rows (e.g. headers or empty lines)
                # Usually, rank must be numeric or start with a digit
                if rank.isdigit() or (rank and rank[0].isdigit()):
                    parsed_data.append({
                        "rank": int(rank) if rank.isdigit() else rank,
                        "name": name,
                        "activities": int(activities) if activities.isdigit() else activities
                    })

        if not parsed_data:
            raise Exception("Failed to extract any university data rows from the HTML table")

        # Sort data by activities descending, then rank (to make sure it's consistent)
        try:
            parsed_data.sort(key=lambda x: int(x["activities"]) if str(x["activities"]).isdigit() else 0, reverse=True)
        except Exception:
            pass

        # 5. Update global cache
        with cache_lock:
            stats_cache["data"] = parsed_data
            stats_cache["last_updated"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            stats_cache["status"] = "success"
            stats_cache["error_message"] = None
        logger.info(f"Scraped and cached {len(parsed_data)} university rows successfully.")

    except Exception as e:
        error_msg = str(e)
        logger.error(f"Error scraping data: {error_msg}")

        # Mark as stale but retain previous data if we already had it
        with cache_lock:
            if stats_cache["status"] in ["success", "stale"] and stats_cache["data"]:
                stats_cache["status"] = "stale"
            else:
                stats_cache["status"] = "error"
            stats_cache["error_message"] = error_msg

def background_scraper_thread():
    """Background scraping loop that runs every 5 seconds."""
    logger.info("Starting background scraper daemon thread...")
    while True:
        scrape_and_update()
        time.sleep(5)

# Check if running in a Serverless environment (like Vercel)
IS_VERCEL = os.environ.get('VERCEL') is not None

if not IS_VERCEL:
    # Initialize and start background thread for local environments
    worker = threading.Thread(target=background_scraper_thread, daemon=True)
    worker.start()

def get_cache_age_seconds():
    """Calculates the age of the cached data in seconds."""
    with cache_lock:
        if not stats_cache["last_updated"]:
            return 999999
        try:
            last_updated_time = datetime.datetime.strptime(stats_cache["last_updated"], "%Y-%m-%d %H:%M:%S")
            return (datetime.datetime.now() - last_updated_time).total_seconds()
        except Exception:
            return 999999


def _get_field(soup, label_text, as_textarea=False):
    """Reads the value of a readonly input/textarea sitting next to a given <label>."""
    for lbl in soup.find_all('label'):
        if lbl.get_text(strip=True) == label_text:
            container = lbl.find_parent('div')
            if container:
                inp = container.find(['input', 'textarea'])
                if inp is not None:
                    if inp.name == 'textarea':
                        return inp.get_text(strip=True)
                    return inp.get('value', '')
    return None


def fetch_activity_date_range(activity_id):
    """Fetches just the start/end date fields from viewActivity.php for a single activity.

    Used to enrich the list view, which otherwise only exposes a single combined date column.
    """
    try:
        r = session.get(VIEW_ACTIVITY_URL, params={"activityId": activity_id},
                         headers=REQUEST_HEADERS, verify=False, timeout=10)
        soup = BeautifulSoup(r.text, 'html.parser')
        start = _get_field(soup, "تاريخ بداية النشاط")
        end = _get_field(soup, "تاريخ نهاية النشاط")
        return activity_id, start, end
    except Exception:
        return activity_id, None, None


def fetch_university_activities(start=0, length=25, search=""):
    """Fetches a page of activities for the university (college id=1 = whole-university view)
    and enriches each row with its start/end date pulled from the detail page."""
    ensure_authenticated()

    payload = {
        "draw": 1,
        "start": start,
        "length": length,
        "yearselect": -1,
        "collselect": -1,
        "topicselect": -1,
        "typeselect": -1,
        "search_type": 1,
        "nashat_name": search,
        "id": 1,
    }
    ajax_headers = dict(REQUEST_HEADERS)
    ajax_headers["X-Requested-With"] = "XMLHttpRequest"

    r = session.post(ACTIVITIES_AJAX_URL, data=payload, headers=ajax_headers, verify=False, timeout=20)

    def looks_logged_out(resp):
        return "logins.php" in resp.url or ("اسم المستخدم" in resp.text[:2000] and "كلمة المرور" in resp.text[:2000])

    if looks_logged_out(r):
        global is_authenticated
        is_authenticated = False
        ensure_authenticated()
        r = session.post(ACTIVITIES_AJAX_URL, data=payload, headers=ajax_headers, verify=False, timeout=20)

    data = r.json()
    raw_rows = data.get("data", [])

    activities = []
    for row in raw_rows:
        activities.append({
            "id": str(row[1]),
            "university": row[2],
            "college": row[3],
            "nature": row[4],
            "type": row[5],
            "name": row[6],
            "date": row[7],
            "students": row[8],
        })

    # Enrich with start/end dates fetched concurrently from each activity's detail page
    if activities:
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            results = list(executor.map(fetch_activity_date_range, [a["id"] for a in activities]))
        date_map = {aid: (s, e) for aid, s, e in results}
        for a in activities:
            s, e = date_map.get(a["id"], (None, None))
            a["start_date"] = s or a["date"]
            a["end_date"] = e or a["date"]

    return {
        "recordsTotal": data.get("recordsTotal", 0),
        "recordsFiltered": data.get("recordsFiltered", 0),
        "data": activities,
    }


def fetch_activity_detail(activity_id):
    """Fetches full details for one activity from viewActivity.php, mirroring the ministry site."""
    ensure_authenticated()

    r = session.get(VIEW_ACTIVITY_URL, params={"activityId": activity_id},
                     headers=REQUEST_HEADERS, verify=False, timeout=20)

    if "logins.php" in r.url or ("اسم المستخدم" in r.text[:2000] and "كلمة المرور" in r.text[:2000]):
        global is_authenticated
        is_authenticated = False
        ensure_authenticated()
        r = session.get(VIEW_ACTIVITY_URL, params={"activityId": activity_id},
                         headers=REQUEST_HEADERS, verify=False, timeout=20)

    if "النشاط غير موجود" in r.text:
        return None

    soup = BeautifulSoup(r.text, 'html.parser')

    description = None
    desc_heading = soup.find(string=lambda s: s and "وصف النشاط" in s)
    if desc_heading:
        section = desc_heading.find_parent(['div', 'section'])
        if section:
            textarea = section.find_next('textarea')
            if textarea:
                description = textarea.get_text(strip=True)

    assigned_by = None
    assign_heading = soup.find(string=lambda s: s and "تم التكليف من قبل" in s)
    if assign_heading:
        section = assign_heading.find_parent(['div', 'section'])
        if section:
            inp = section.find_next(['input', 'textarea'])
            if inp:
                assigned_by = inp.get('value', '') if inp.name == 'input' else inp.get_text(strip=True)

    attachments = []
    attach_heading = soup.find(string=lambda s: s and "المرفقات" in s)
    if attach_heading:
        section = attach_heading.find_parent(['div', 'section'])
        if section:
            for a_tag in section.find_all('a', href=True):
                attachments.append({"label": a_tag.get_text(strip=True) or "مرفق", "href": a_tag['href']})

    return {
        "id": activity_id,
        "university": _get_field(soup, "الجامعة"),
        "college": _get_field(soup, "الكلية"),
        "name": _get_field(soup, "اسم النشاط"),
        "nature": _get_field(soup, "طبيعة النشاط"),
        "type": _get_field(soup, "نوع النشاط"),
        "status": _get_field(soup, "حالة النشاط"),
        "start_date": _get_field(soup, "تاريخ بداية النشاط"),
        "end_date": _get_field(soup, "تاريخ نهاية النشاط"),
        "assigned_by": assigned_by,
        "description": description,
        "students_expatriates": _get_field(soup, "وافدين"),
        "students_egyptians": _get_field(soup, "مصريين"),
        "students_special_needs": _get_field(soup, "ذوي الاحتياجات"),
        "students_total": _get_field(soup, "الإجمالي"),
        "attachments": attachments,
    }


@app.route('/')
def index():
    """Serves the main dashboard page."""
    return render_template('index.html')

@app.route('/api/stats')
def get_stats():
    """Returns the cached statistics as JSON."""
    if IS_VERCEL:
        # On serverless (Vercel), we fetch synchronously if cache is empty or older than 10 seconds
        if get_cache_age_seconds() > 10:
            logger.info("Vercel environment: Cache expired. Scraping synchronously...")
            scrape_and_update()

    with cache_lock:
        return jsonify(stats_cache)


@app.route('/api/university-activities')
def get_university_activities():
    """Returns a page of Zagazig National University activities (name, dates, student count)."""
    try:
        start = request.args.get('start', default=0, type=int) or 0
        length = request.args.get('length', default=25, type=int) or 25
        search = request.args.get('search', default='', type=str) or ''
        result = fetch_university_activities(start=start, length=length, search=search)
        return jsonify({"status": "success", **result})
    except Exception as e:
        logger.error(f"Error fetching university activities: {e}")
        return jsonify({"status": "error", "error_message": str(e)}), 500


@app.route('/api/activity/<activity_id>')
def get_activity_detail(activity_id):
    """Returns full details for a single activity (matches the ministry site's detail view)."""
    try:
        detail = fetch_activity_detail(activity_id)
        if detail is None:
            return jsonify({"status": "not_found", "error_message": "النشاط غير موجود"}), 404
        return jsonify({"status": "success", "data": detail})
    except Exception as e:
        logger.error(f"Error fetching activity detail for {activity_id}: {e}")
        return jsonify({"status": "error", "error_message": str(e)}), 500


if __name__ == '__main__':
    # We turn off Flask auto-reloader to prevent the background thread from running twice.
    # Runs on localhost port 5000 by default.
    app.run(host='127.0.0.1', port=5000, debug=True, use_reloader=False)
