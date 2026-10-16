"""Train a compact holdout-tested Random Forest for the CityFix demo."""
import csv, json, math, random
from pathlib import Path
ROOT=Path(__file__).resolve().parent
RAW=ROOT/"data"/"raw"/"03_smart_city_where_fix_first"
def read(name):
    with (RAW/name).open(encoding="utf-8-sig",newline="") as f: return list(csv.DictReader(f))
locations={r["location_id"]:r for r in read("locations.csv")}
inc={k:[0]*12 for k in locations}; comp={k:[0]*12 for k in locations}
for r in read("incidents.csv"):
    if r["location_id"] in inc: inc[r["location_id"]][int(r["timestamp"][5:7])-1]+=1
for r in read("public_complaints.csv"):
    if r["location_id"] in comp: comp[r["location_id"]][int(r["created_at"][5:7])-1]+=1
road={"Good":0,"Fair":1,"Poor":2,"Critical":3}; ped={"Low":0,"Medium":1,"High":2}
samples=[]
for key,loc in locations.items():
    x=[sum(inc[key][i:i+3]) for i in (0,3,6)]+[sum(comp[key][i:i+3]) for i in (0,3,6)]+[road.get(loc["road_condition"],1),ped.get(loc["pedestrian_activity"],1),int(loc["near_school"]=="1"),int(loc["near_hospital"]=="1"),float(loc["population_density_per_km2"])/1000]
    samples.append({"x":x,"y":sum(inc[key][9:12]),"test":int(key.lstrip("L"))%5==0})
train=[s for s in samples if not s["test"]]; test=[s for s in samples if s["test"]]
def avg(rows): return sum(r["y"] for r in rows)/max(1,len(rows))
def build(rows,depth,rng):
    m=avg(rows)
    if depth>=4 or len(rows)<36 or len({r["y"] for r in rows})<2: return {"v":round(m,4)}
    best=None
    for f in rng.sample(range(len(rows[0]["x"])),4):
        vals=sorted({r["x"][f] for r in rows}); cuts=sorted({vals[min(len(vals)-1,int(len(vals)*p))] for p in (.2,.4,.6,.8)})[:-1]
        for cut in cuts:
            left=[r for r in rows if r["x"][f]<=cut]; right=[r for r in rows if r["x"][f]>cut]
            if min(len(left),len(right))<12: continue
            lm,rm=avg(left),avg(right); err=sum((r["y"]-lm)**2 for r in left)+sum((r["y"]-rm)**2 for r in right)
            if best is None or err<best[0]: best=(err,f,cut,left,right)
    if best is None: return {"v":round(m,4)}
    _,f,cut,left,right=best
    return {"f":f,"t":cut,"l":build(left,depth+1,rng),"r":build(right,depth+1,rng)}
def walk(t,x):
    while "v" not in t: t=t["l"] if x[t["f"]]<=t["t"] else t["r"]
    return t["v"]
rng=random.Random(2025)
trees=[build([train[rng.randrange(len(train))] for _ in train],0,rng) for _ in range(36)]
def predict(x): return sum(walk(t,x) for t in trees)/len(trees)
errors=[predict(s["x"])-s["y"] for s in test]
mae=sum(abs(v) for v in errors)/len(errors); rmse=math.sqrt(sum(v*v for v in errors)/len(errors)); baseline=sum(abs(s["y"]-avg(train)) for s in test)/len(test)
model={"model":"CityFix Random Forest Regressor","target":"Q4 incident count","featureNames":["Q1 incidents","Q2 incidents","Q3 incidents","Q1 complaints","Q2 complaints","Q3 complaints","road condition","pedestrian activity","near school","near hospital","density per 1k"],"treeCount":len(trees),"maxDepth":4,"trainLocations":len(train),"testLocations":len(test),"metrics":{"mae":round(mae,3),"rmse":round(rmse,3),"baselineMae":round(baseline,3)},"trees":trees}
(ROOT/"forecast-model.json").write_text(json.dumps(model,separators=(",",":")),encoding="utf-8")
print(f"Random Forest: {len(trees)} trees; {len(train)} train / {len(test)} holdout; MAE {mae:.2f} vs baseline {baseline:.2f}")

