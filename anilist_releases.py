from datetime import datetime, time, timedelta, timezone
import json
import urllib.request
import ssl
import sys
import argparse
import os

# AniList GraphQL API endpoint
ANILIST_API_URL = "https://graphql.anilist.co"

def get_today_airing_anime(start_timestamp, end_timestamp, page=1, per_page=50):
    """
    Fetches anime airing today from AniList API within the given UTC timestamp range.
    """
    full_query = """
    query AiringSchedule($page: Int, $perPage: Int, $airingAt_greater: Int, $airingAt_lesser: Int) {
      Page(page: $page, perPage: $perPage) {
        pageInfo {
          total
          currentPage
          lastPage
          hasNextPage
          perPage
        }
        airingSchedules(airingAt_greater: $airingAt_greater, airingAt_lesser: $airingAt_lesser, sort: TIME) {
          id
          airingAt
          timeUntilAiring
          episode
          media {
            id
            title {
              romaji
              english
              native
            }
            coverImage {
              large
            }
          }
        }
      }
    }
    """

    ping_query = """
    query AiringSchedule($airingAt_greater: Int, $airingAt_lesser: Int) {
      Page(page: 1, perPage: 50) {
        pageInfo {
          hasNextPage
        }
        # Fetch only the airingAt timestamp for a lightweight but robust check.
        airingSchedules(airingAt_greater: $airingAt_greater, airingAt_lesser: $airingAt_lesser, sort: TIME) {
          airingAt
        }
      }
    }
    """

    query = ping_query if "ping" in sys.argv else full_query
    variables = {
        'page': page,
        'perPage': per_page,
        'airingAt_greater': start_timestamp,
        'airingAt_lesser': end_timestamp
    }

    data = json.dumps({'query': query, 'variables': variables}).encode('utf-8')
    headers = {'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'}
    req = urllib.request.Request(ANILIST_API_URL, data=data, headers=headers)

    # --- Attempt 1: Secure connection using default SSL context ---
    # Define path for custom CA bundle
    script_dir = os.path.dirname(os.path.abspath(__file__))
    custom_ca_file = os.path.join(script_dir, 'data', 'ca.pem')

    try:
        if os.path.exists(custom_ca_file):
            print("Info: Using custom 'ca.pem' for SSL verification.", file=sys.stderr)
            secure_context = ssl.create_default_context(cafile=custom_ca_file)
        else:
            # ssl.create_default_context() uses the system's trusted CAs for verification.
            secure_context = ssl.create_default_context()

        with urllib.request.urlopen(req, context=secure_context, timeout=15) as response:
            if response.status != 200:
                print(f"Error: Received status code {response.status}", file=sys.stderr)
                return None
            return json.loads(response.read().decode('utf-8'))
    except urllib.error.URLError as e:
        # Check if the error is specifically an SSL certificate verification failure.
        if isinstance(e.reason, ssl.SSLCertVerificationError):
            error_message = (
                "Fatal Error: SSL certificate verification failed. This may be due to an "
                "outdated system certificate store or a corporate proxy intercepting the connection.\n"
                "To resolve this, you can:\n"
                "1. Ensure your operating system and browser are fully updated.\n"
                "2. If on a corporate network, place the required certificate authority file named 'ca.pem' "
                f"inside the 'data' directory located at: {os.path.join(script_dir, 'data')}\n"
                "The connection was aborted to protect your security."
            )
            print(error_message, file=sys.stderr)
            return None
        else:
            # The error was not SSL-related (e.g., DNS failure, connection refused).
            print(f"Error fetching data: {e}", file=sys.stderr)
            return None
    except Exception as e:
        # Catch any other unexpected errors (e.g., JSON decoding).
        print(f"An unexpected error occurred: {e}", file=sys.stderr)
        return None

def convert_utc_to_local(utc_timestamp):
    """
    Converts a UTC Unix timestamp to the local timezone and returns a formatted string.
    """
    if utc_timestamp is None:
        return "N/A"

    utc_dt = datetime.fromtimestamp(utc_timestamp, tz=timezone.utc)
    local_tz = datetime.now().astimezone().tzinfo
    local_dt = utc_dt.astimezone(local_tz)
    return local_dt.strftime("%H:%M")

def main():
    parser = argparse.ArgumentParser(description="Fetch AniList airing schedule.")
    parser.add_argument('--ping', action='store_true', help='Only fetch the total count of releases.')
    args = parser.parse_args()

    if args.ping:
        # In ping mode, we don't need to print this verbose message.
        pass
    else:
        print("Fetching anime episodes releasing today...", file=sys.stderr)
    
    # Get the current time in the user's local timezone
    local_tz = datetime.now().astimezone().tzinfo
    now_local = datetime.now(local_tz)

    # Determine the start and end of the current day in the local timezone
    start_of_day_local = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    end_of_day_local = start_of_day_local + timedelta(days=1) - timedelta(microseconds=1)

    # Convert the local start and end times to UTC timestamps for the API query
    start_timestamp_utc = int(start_of_day_local.astimezone(timezone.utc).timestamp())
    end_timestamp_utc = int(end_of_day_local.astimezone(timezone.utc).timestamp())

    all_schedules = []
    page = 1
    total_from_api = 0
    has_next_page = True

    # --- Ping Logic ---
    if args.ping:
        all_airing_ats = []
        page = 1
        has_next_page = True
        while has_next_page and page <= 5: # Safety limit of 5 pages
            data = get_today_airing_anime(start_timestamp_utc, end_timestamp_utc, page=page)
            if not data:
                sys.exit("Failed to ping AniList for release timestamps.")

            schedules = data.get('data', {}).get('Page', {}).get('airingSchedules', [])
            page_info = data.get('data', {}).get('Page', {}).get('pageInfo', {})

            all_airing_ats.extend([s['airingAt'] for s in schedules])
            
            has_next_page = page_info.get('hasNextPage', False)
            page += 1

        # The output is now a list of all timestamps for the day.
        # The native host will compare this list to the cached list.
        # We also include the total count for backwards compatibility and potential future use.
        print(json.dumps({"airingAt_list": all_airing_ats, "total": len(all_airing_ats)}))
        return # End execution after ping.

    while has_next_page and page <= 5:
        data = get_today_airing_anime(start_timestamp_utc, end_timestamp_utc, page=page)
        if not data:
            break
        
        schedules = data.get('data', {}).get('Page', {}).get('airingSchedules', [])
        page_info = data.get('data', {}).get('Page', {}).get('pageInfo', {})

        if page == 1: # Capture the total from the first page response
            total_from_api = page_info.get('total', 0)

        all_schedules.extend(schedules)
        
        has_next_page = page_info.get('hasNextPage', False)
        page += 1
    
    if not all_schedules:
        # Even if there are no releases for the day, we should report the total
        # count from the API if we got it, as it might be non-zero for other pages.
        print(json.dumps({"releases": [], "total": total_from_api}))
        return

    all_schedules.sort(key=lambda x: x['airingAt'])

    output_data = []
    now_utc_timestamp = datetime.now(timezone.utc).timestamp()
    for schedule in all_schedules:
        media = schedule['media']
        title = media['title']['english'] or media['title']['romaji'] or media['title']['native']
        episode = schedule['episode']
        airing_at_utc = schedule['airingAt']
        
        local_airing_time = convert_utc_to_local(airing_at_utc)
        
        output_data.append({
            'id': media['id'],
            'title': title,
            'episode': episode,
            'airing_at': local_airing_time,
            'cover_image': media.get('coverImage', {}).get('large', '')
        })

    # Find the timestamp of the next episode that hasn't aired yet.
    next_airing_at = None
    for schedule in all_schedules:
        if schedule['airingAt'] > now_utc_timestamp:
            next_airing_at = schedule['airingAt']
            break # Since the list is sorted, the first one we find is the next one.

    # Structure the final output to include the total count
    final_output = {
        "releases": output_data,
        "total": total_from_api, # Use the authoritative total from the API
        "next_airing_at": next_airing_at, # Add the timestamp for the next release
        "raw_schedules_for_cache": all_schedules # Provide the raw data for caching purposes
    }
    print(json.dumps(final_output, indent=4))

if __name__ == "__main__":
    main()