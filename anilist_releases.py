from datetime import datetime, time, timedelta, timezone
import json
import urllib.request
import ssl
import sys

# AniList GraphQL API endpoint
ANILIST_API_URL = "https://graphql.anilist.co"

def get_today_airing_anime(start_timestamp, end_timestamp, page=1, per_page=50):
    """
    Fetches anime airing today from AniList API within the given UTC timestamp range.
    """
    query = """
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
    try:
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
            print("Warning: SSL certificate verification failed. This may be due to an outdated system certificate store or a corporate proxy. Falling back to an insecure connection.", file=sys.stderr)
            
            # --- Attempt 2: Insecure fallback ---
            try:
                # ssl._create_unverified_context() disables certificate verification. This is a security risk.
                insecure_context = ssl._create_unverified_context()
                with urllib.request.urlopen(req, context=insecure_context, timeout=15) as response:
                    if response.status != 200:
                        print(f"Error (insecure fallback): Received status code {response.status}", file=sys.stderr)
                        return None
                    return json.loads(response.read().decode('utf-8'))
            except urllib.error.URLError as e_insecure:
                print(f"Error fetching data with insecure fallback: {e_insecure}", file=sys.stderr)
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
    print("Fetching anime episodes releasing today...", file=sys.stderr)
    
    today_local = datetime.now().date()
    local_tz = datetime.now().astimezone().tzinfo

    # Create naive datetime objects for the start and end of the local day.
    # The .combine() method does not accept a tzinfo argument.
    start_of_today_naive = datetime.combine(today_local, time.min)
    end_of_today_naive = datetime.combine(today_local, time.max)

    # Make the naive datetimes timezone-aware using the local timezone.
    start_of_today_local = start_of_today_naive.replace(tzinfo=local_tz)
    end_of_today_local = end_of_today_naive.replace(tzinfo=local_tz)

    start_timestamp_utc = int(start_of_today_local.timestamp())
    end_timestamp_utc = int(end_of_today_local.timestamp())

    all_schedules = []
    page = 1
    has_next_page = True

    while has_next_page and page <= 5:
        data = get_today_airing_anime(start_timestamp_utc, end_timestamp_utc, page=page)
        if not data:
            break
        
        schedules = data.get('data', {}).get('Page', {}).get('airingSchedules', [])
        page_info = data.get('data', {}).get('Page', {}).get('pageInfo', {})

        all_schedules.extend(schedules)
        
        has_next_page = page_info.get('hasNextPage', False)
        page += 1
    
    if not all_schedules:
        print("[]") # Print empty JSON array if no releases
        return

    all_schedules.sort(key=lambda x: x['airingAt'])

    output_data = []
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

    print(json.dumps(output_data, indent=4))

if __name__ == "__main__":
    main()