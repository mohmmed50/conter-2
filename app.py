import os
import threading
import time
import datetime
import logging
import requests
from bs4 import BeautifulSoup
from flask import Flask, jsonify, render_template, send_from_directory
import urllib3

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
USERNAME = "ZNU_super"
PASSWORD = "ZNU_super_2025"

# Maintain session cookies across requests
session = requests.Session()
is_authenticated = False

def do_login(sess):
    """Performs the POST login request to authenticate the session."""
    global is_authenticated
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
    
    if r.status_code != 200:
        is_authenticated = False
        raise Exception(f"Login failed: HTTP status code {r.status_code}")
        
    # Check if login was rejected by reading the HTML content
    if "اسم المستخدم" in r.text and "كلمة المرور" in r.text and ("خطأ" in r.text or "Error" in r.text or "عفواً" in r.text):
        is_authenticated = False
        raise Exception("Login failed: Invalid credentials or account blocked")
        
    is_authenticated = True
    logger.info("Login successful. Session cookies established.")
    return True

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
            soup = BeautifulSoup(r.text, 'html.parser')
            table = soup.find('table')
            
        if not table:
            raise Exception("HTML table element not found on statistics page")
            
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

if __name__ == '__main__':
    # We turn off Flask auto-reloader to prevent the background thread from running twice.
    # Runs on localhost port 5000 by default.
    app.run(host='127.0.0.1', port=5000, debug=True, use_reloader=False)
